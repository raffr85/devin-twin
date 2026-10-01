import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { execSync } from "node:child_process";
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
};

const NARRATOR = `Você é um monitor ao vivo de uma sessão do Devin rodando localmente no Mac {HOST}. Você NUNCA executa trabalho — só observa, resume e repassa respostas do usuário. Use SOMENTE as tools mac_* do servidor MCP configurado.

A sessão local monitorada é o handle {HANDLE} ("{TITLE}").

Quando você receber uma mensagem começando com "⟳": chame mac_get_events com esse handle (passe since = o último nextSince que você recebeu; se não tiver, omita) e escreva UMA atualização neste formato exato:

**<emoji> <Estado>** · {TITLE curto} · <localTime retornado pela tool>
2–4 frases sobre o que o agente local fez (comandos/arquivos em \`backticks\`).
*Última mensagem dele:* "<lastAssistantMessage, máx 2 frases>"
Se houver pendência: **Aguardando você:** <summary>. Responda **aprovar** ou **negar**.

Emojis: ▶ rodando · ⏸ aguardando você · ✓ concluído · ✗ erro · 🔒 aberta no Desktop.

Mensagens do usuário que NÃO começam com "⟳" são comandos: "aprovar"/"negar" → chame mac_get_pending_actions e mac_respond_permission com a pendência dessa sessão; qualquer outro texto → mac_send_message com o handle e o texto (relate o campo delivery); perguntas → responda brevemente com base em mac_get_events/mac_get_session. Nunca aprove por conta própria; nunca peça confirmação para ler; nunca saia do formato acima.

Primeira ação: faça a primeira atualização agora.`;

const COALESCE_MS = 20_000;

export class TwinManager {
  private twins: Record<string, TwinRec> = {};
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
      if (existsSync(file)) this.twins = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.twins, null, 2));
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
      const prompt = NARRATOR.replace("{HANDLE}", meta.handle)
        .replace("{TITLE}", title)
        .replace("{HOST}", host);
      const created = await this.api.createSession({
        title: `[${host}] ${title}`,
        tags: [`mac:${host}`],
        devin_mode: "lite",
        max_acu_limit: this.opts.maxAcuLimit,
        structured_output_required: false,
        prompt,
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
    const refresh = kind === "stop" || kind === "session_end";
    const title = (await this.resolveTitle(sessionId, refresh)) ?? meta.title;
    const twin = await this.ensureTwin(sessionId, { ...meta, title });
    if (!twin) return;
    const host = localHostName();

    void push(this.pushCfg, {
      host,
      title: title ?? sessionId,
      body: headline,
      click: twin.url,
      kind,
    });

    const now = Date.now();
    const send = async () => {
      const text = this.pendingHeadline.get(sessionId) ?? headline;
      this.pendingHeadline.delete(sessionId);
      try {
        await this.api!.postMessage(twin.devinId, `⟳ ${text}`);
        twin.lastTriggerAt = Date.now();
        this.persist();
      } catch (e) {
        audit({ event: "twin_trigger_failed", devinId: twin.devinId, error: String(e) });
      }
    };
    if (kind === "permission_request") {
      const t = this.timers.get(sessionId);
      if (t) clearTimeout(t);
      await send();
      return;
    }
    if (kind === "session_end") {
      const t = this.timers.get(sessionId);
      if (t) clearTimeout(t);
      await send();
      if (this.opts.archiveOnEnd) await this.archive(sessionId);
      return;
    }
    const elapsed = now - twin.lastTriggerAt;
    if (elapsed >= COALESCE_MS) {
      await send();
    } else {
      this.pendingHeadline.set(sessionId, headline);
      if (!this.timers.has(sessionId)) {
        this.timers.set(
          sessionId,
          setTimeout(() => {
            this.timers.delete(sessionId);
            void send();
          }, COALESCE_MS - elapsed),
        );
      }
    }
  }
}
