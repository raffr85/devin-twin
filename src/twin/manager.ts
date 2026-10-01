import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname as osHostname } from "node:os";
import type { DevinApi } from "./api.ts";
import type { PushConfig } from "../push.ts";
import type { EventStore } from "../events.ts";
import { push } from "../push.ts";
import { audit } from "../audit.ts";

export function localHostName(): string {
  try {
    return execSync("scutil --get LocalHostName", { encoding: "utf8" }).trim();
  } catch {
    return osHostname();
  }
}

export type TwinRec = {
  devinId: string;
  url: string;
  createdAt: string;
  lastTriggerAt: number;
  archived: boolean;
  /** local session ids (continuations) that also feed this twin */
  aliases?: string[];
};

const PLAYBOOK_TITLE = "Devin Twin · narrator";

// Org-level playbook body — no session-specific placeholders; the twin learns
// its local session handle from the first "⟳ <handle> · <título>" message.
export const NARRATOR_BODY = `Você é um monitor ao vivo de uma sessão do Devin rodando localmente num Mac do usuário. Você NUNCA executa trabalho — só observa, resume e repassa respostas do usuário. Use SOMENTE as tools mac_* do servidor MCP configurado.

A primeira mensagem do usuário tem o formato \`⟳ <handle> · <título>\`: esse é o handle da sessão local a monitorar; guarde-o.

Quando você receber uma mensagem "⟳": chame mac_get_events com o handle guardado (passe since = o último nextSince que você recebeu; se não tiver, omita) e escreva UMA atualização neste formato exato — cada bloco DEVE ser separado por uma linha em branco:

**<emoji> <Estado>** · <título curto> · <localTime retornado pela tool>

- <ação 1: comando ou arquivo em \`backticks\`>
- <ação 2>
- <ação 3 (máx 4 itens)>

*Última mensagem dele:*
> <lastAssistantMessage, até 2 frases>

**Aguardando você:** <summary> — responda **aprovar** ou **negar**.   ← só se houver pendência

O bloco de citação usa \`>\`. Emojis: ▶ rodando · ⏸ aguardando você · ✓ concluído · ✗ erro · 🔒 aberta no Desktop.

Ao enviar instruções com mac_send_message, relate o campo \`delivery\`: "acp_now" → "Enviado; a sessão está rodando." · "hook_live" → "Enviado; o agente recebe em instantes." · "queued_idle_locked" → "A sessão está parada no Desktop; sua instrução fica na fila. Quer que eu continue numa nova sessão com o contexto dela? Responda **continuar**." — se o usuário responder "continuar", chame mac_continue_session com o handle e a última instrução, e passe a monitorar o novo handle retornado.

Mensagens do usuário que NÃO começam com "⟳" são comandos: "aprovar"/"negar" → chame mac_get_pending_actions e mac_respond_permission com a pendência dessa sessão; qualquer outro texto → mac_send_message com o handle e o texto (relate o campo delivery); perguntas → responda brevemente com base em mac_get_events/mac_get_session. Nunca aprove por conta própria; nunca peça confirmação para ler; nunca saia do formato acima.

Primeira ação: faça a primeira atualização agora.`;

const COALESCE_MS = 20_000;

export class TwinManager {
  private twins: Record<string, TwinRec> = {};
  private playbook: { id: string; sha: string } | null = null;
  private playbookPromise: Promise<string | null> | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingHeadline = new Map<string, string>();

  constructor(
    private file: string,
    private api: DevinApi | null,
    private pushCfg: PushConfig,
    private opts: {
      maxAcuLimit: number;
      archiveOnEnd: boolean;
      isRemoteOn: () => boolean;
      events?: EventStore;
      lookupTitle?: (sid: string) => Promise<string | null>;
    },
  ) {
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const { _playbook, ...rest } = raw;
        this.twins = rest as Record<string, TwinRec>;
        this.playbook = (_playbook as { id: string; sha: string }) ?? null;
      }
    } catch {}
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify({ ...this.twins, _playbook: this.playbook }, null, 2),
    );
  }

  list(): Record<string, TwinRec> {
    return this.twins;
  }

  // Title resolution: live/cached title → ACP session list → first user prompt.
  // refresh=true re-runs the ACP lookup (late-set titles land on stop/session_end).
  async resolveTitle(sid: string, refresh = false): Promise<string | null> {
    const ev = this.opts.events;
    const live = ev?.live(sid);
    if (!refresh && live?.title) return live.title;
    if (this.opts.lookupTitle && ev) {
      try {
        const t = await this.opts.lookupTitle(sid);
        if (t && t.trim()) {
          ev.setTitle(sid, t.trim());
          return t.trim();
        }
      } catch {}
    }
    if (live?.title) return live.title;
    const first = ev?.list(sid, 0, 500).events.find((e) => e.kind === "user_prompt");
    const prompt = first ? String(first.data.prompt ?? "") : "";
    const clean = prompt.replace(/[`\n\r]+/g, " ").replace(/\s+/g, " ").trim();
    return clean ? (clean.length > 60 ? clean.slice(0, 60) + "…" : clean) : null;
  }

  async archive(localSessionId: string): Promise<boolean> {
    const t = this.twins[localSessionId];
    if (!t || t.archived) return false;
    if (this.api) {
      try {
        await this.api.archive(t.devinId);
      } catch (e) {
        audit({ event: "twin_archive_failed", devinId: t.devinId, error: String(e) });
        return false;
      }
    }
    t.archived = true;
    this.persist();
    return true;
  }

  async archiveAll(): Promise<number> {
    let n = 0;
    for (const id of Object.keys(this.twins)) {
      if (await this.archive(id)) n++;
    }
    return n;
  }

  // Ensure the org playbook exists and matches the current NARRATOR_BODY.
  private ensurePlaybook(): Promise<string | null> {
    if (!this.playbookPromise) {
      this.playbookPromise = (async () => {
        if (!this.api) return null;
        const sha = createHash("sha256").update(NARRATOR_BODY).digest("hex").slice(0, 16);
        try {
          if (this.playbook) {
            const existing = await this.api.getPlaybook(this.playbook.id);
            if (existing) {
              if (this.playbook.sha !== sha) {
                await this.api.updatePlaybook(this.playbook.id, PLAYBOOK_TITLE, NARRATOR_BODY);
                this.playbook.sha = sha;
                this.persist();
                audit({ event: "playbook_updated", playbookId: this.playbook.id });
              }
              return this.playbook.id;
            }
          }
          const created = await this.api.createPlaybook(PLAYBOOK_TITLE, NARRATOR_BODY);
          this.playbook = { id: created.playbook_id, sha };
          this.persist();
          audit({ event: "playbook_created", playbookId: this.playbook.id });
          return this.playbook.id;
        } catch (e) {
          audit({ event: "playbook_failed", error: String(e) });
          return null;
        }
      })();
    }
    return this.playbookPromise;
  }

  /** Map a session id to the canonical key of an existing twin (via aliases). */
  private canonical(sessionId: string): string {
    if (this.twins[sessionId]) return sessionId;
    for (const [k, rec] of Object.entries(this.twins)) {
      if (rec.aliases?.includes(sessionId)) return k;
    }
    return sessionId;
  }

  /** Continuation sessions feed the same twin. */
  addAlias(origSessionId: string, newSessionId: string): void {
    const rec = this.twins[this.canonical(origSessionId)];
    if (!rec) return;
    rec.aliases = [...(rec.aliases ?? []), newSessionId];
    this.persist();
    audit({ event: "twin_alias", from: origSessionId, to: newSessionId, devinId: rec.devinId });
  }

  async ensureTwin(
    sessionId: string,
    meta: { title?: string | null; cwd?: string | null; handle: string },
  ): Promise<TwinRec | null> {
    const existing = this.twins[sessionId];
    if (existing && !existing.archived) return existing;
    if (!this.api || !this.opts.isRemoteOn()) return null;
    const host = localHostName();
    const title =
      meta.title || (await this.resolveTitle(sessionId)) ||
      (meta.cwd ? basename(meta.cwd) : sessionId);
    try {
      const playbookId = await this.ensurePlaybook();
      const created = await this.api.createSession({
        title: `[${host}] ${title}`,
        tags: [`mac:${host}`],
        devin_mode: "lite",
        max_acu_limit: this.opts.maxAcuLimit,
        structured_output_required: false,
        ...(playbookId ? { playbook_id: playbookId } : {}),
        prompt: `⟳ ${meta.handle} · ${title}`,
      });
      const rec: TwinRec = {
        devinId: created.session_id,
        url: created.url,
        createdAt: new Date().toISOString(),
        lastTriggerAt: 0,
        archived: false,
      };
      this.twins[sessionId] = rec;
      this.persist();
      audit({ event: "twin_created", session: meta.handle, devinId: rec.devinId, url: rec.url });
      return rec;
    } catch (e) {
      audit({ event: "twin_create_failed", session: meta.handle, error: String(e) });
      return null;
    }
  }

  // Milestone → trigger message to the twin (+ ntfy push). Coalesced 20s per twin,
  // except permission_request which goes immediately.
  async trigger(
    sessionId: string,
    headline: string,
    kind: string,
    meta: { title?: string | null; cwd?: string | null; handle: string },
  ): Promise<void> {
    if (!this.opts.isRemoteOn()) return;
    const canon = this.canonical(sessionId);
    const isContinuation = canon !== sessionId;
    const refresh = kind === "stop" || kind === "session_end";
    const title = (await this.resolveTitle(sessionId, refresh)) ?? meta.title;
    const twin = await this.ensureTwin(canon, { ...meta, title });
    if (!twin) return;
    const host = localHostName();

    void push(this.pushCfg, {
      host,
      title: `${title ?? sessionId}${isContinuation ? " (continuação)" : ""}`,
      body: headline,
      click: twin.url,
      kind,
    });

    const now = Date.now();
    const send = async () => {
      this.pendingHeadline.delete(canon);
      try {
        await this.api!.postMessage(twin.devinId, "⟳");
        twin.lastTriggerAt = Date.now();
        this.persist();
      } catch (e) {
        audit({ event: "twin_trigger_failed", devinId: twin.devinId, error: String(e) });
      }
    };
    if (kind === "permission_request") {
      const t = this.timers.get(canon);
      if (t) clearTimeout(t);
      await send();
      return;
    }
    if (kind === "session_end") {
      const t = this.timers.get(canon);
      if (t) clearTimeout(t);
      await send();
      if (this.opts.archiveOnEnd) await this.archive(canon);
      return;
    }
    const elapsed = now - twin.lastTriggerAt;
    if (elapsed >= COALESCE_MS) {
      await send();
    } else {
      this.pendingHeadline.set(canon, headline);
      if (!this.timers.has(canon)) {
        this.timers.set(
          canon,
          setTimeout(() => {
            this.timers.delete(canon);
            void send();
          }, COALESCE_MS - elapsed),
        );
      }
    }
  }
}
