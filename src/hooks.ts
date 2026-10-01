import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EventStore } from "./events.ts";
import type { InstructionQueue } from "./queue.ts";
import type { TwinManager } from "./twin/manager.ts";
import type { HandleMap } from "./handles.ts";
import { addPendingHookPermission, drop } from "./pending.ts";
import { audit } from "./audit.ts";
import { pidAlive } from "./cli/state.ts";

export type RemoteReader = () => { on: boolean; maxHoldMinutes: number };

function summary(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const raw =
    toolName === "exec"
      ? String(i.command ?? "")
      : ["edit", "write", "read"].includes(toolName)
        ? String(i.path ?? i.file_path ?? i.filePath ?? "")
        : toolName;
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

const PERM_BLOCK = {
  decision: "block",
  reason: "Negado pelo usuário via celular",
};

// The CLI honors large hook timeouts (verified: timeout 7200 sleeps >100s), but
// the hook script's curl --max-time caps one HTTP call at ~900s, so we re-arm:
// just under that cap we return a no-op block, which fires Stop again with
// stop_hook_active=true and lets the hold continue.
const REARM_MS = 840_000;
const REARM_MAX = 48;
const REARM_REASON =
  "Aguardando instruções remotas do usuário (modo ausente). Não faça nada; apenas termine o turno.";

export class HookRuntime {
  private holds = new Set<string>();
  private reArms = new Map<string, number>();
  private holdDeadline = new Map<string, number>();
  private turnFired = new Set<string>();
  drainOnEnd:
    | ((sid: string, cwd: string, text: string) => Promise<void>)
    | null = null;
  /** Re-arm interval inside a hold (prod ~840s; tests shrink it). */
  rearmMs = REARM_MS;

  constructor(
    private events: EventStore,
    private queue: InstructionQueue,
    private twin: TwinManager,
    private handles: HandleMap,
    private remote: RemoteReader,
    private permHoldMs = 540_000,
    private queueTtlMs = 3_600_000,
  ) {}

  isHolding(sid: string): boolean {
    return this.holds.has(sid);
  }

  activeHoldCount(): number {
    return this.holds.size;
  }

  private drainQueue(sid: string, via: string, handle: string): string[] {
    const { items, expired } = this.queue.popAll(sid, this.queueTtlMs);
    for (const text of expired)
      this.events.append(sid, "instruction_expired", { text });
    for (const text of items)
      this.events.append(sid, "instruction_delivered", { text, via });
    if (items.length) audit({ event: "instruction_delivered", session: handle, via });
    if (expired.length) audit({ event: "instruction_expired", session: handle });
    return items;
  }

  private blockWith(items: string[]): Record<string, unknown> {
    return {
      decision: "block",
      reason: `Instrução do usuário enviada pelo celular:\n${items.map((t) => `- ${t}`).join("\n")}`,
    };
  }

  private async drainAfterSessionEnd(sid: string, cwd: string): Promise<void> {
    if (!this.drainOnEnd || this.queue.size(sid) === 0) return;
    const items = this.drainQueue(sid, "acp", this.handles.sessionHandle(sid));
    if (!items.length) return;
    // give the local client a moment to release its session lock
    const lockFile = join(
      homedir(),
      ".local/share/devin/cli/session_locks",
      `${sid}.lock`,
    );
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && existsSync(lockFile)) {
      let pid: number | null = null;
      try {
        pid = Number(readFileSync(lockFile, "utf8").trim()) || null;
      } catch {}
      if (!pid || !pidAlive(pid)) break;
      await Bun.sleep(100);
    }
    try {
      await this.drainOnEnd(sid, cwd, items.join("\n"));
      audit({ event: "queue_drained_on_end", session: this.handles.sessionHandle(sid) });
    } catch (e) {
      for (const text of items) this.queue.enqueue(sid, text);
      audit({
        event: "queue_drain_failed",
        session: this.handles.sessionHandle(sid),
        error: String(e),
      });
    }
  }

  async handle(
    event: string,
    body: Record<string, unknown>,
    cwd: string,
  ): Promise<Record<string, unknown>> {
    const sid = String(body.session_id ?? "");
    if (!sid) return {};
    const meta = {
      title: await this.twin.resolveTitle(sid),
      cwd,
      handle: this.handles.sessionHandle(sid),
    };

    switch (event) {
      case "SessionStart": {
        this.events.append(sid, "session_start", { source: body.source, cwd });
        return {};
      }
      case "UserPromptSubmit": {
        this.turnFired.delete(sid); // a new user turn begins
        const prompt = String(body.prompt ?? "");
        this.events.append(sid, "user_prompt", { prompt });
        const queued = this.drainQueue(sid, "prompt", meta.handle);
        if (queued.length) {
          return {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: `O usuário também enviou pelo celular:\n${queued.map((t) => `- ${t}`).join("\n")}`,
            },
          };
        }
        void this.twin.trigger(sid, `turno iniciado: ${prompt.slice(0, 80)}`, "user_prompt", meta);
        return {};
      }
      case "PostToolUse": {
        const resp = (body.tool_response ?? {}) as Record<string, unknown>;
        this.events.append(sid, "tool", {
          tool_name: body.tool_name,
          summary: summary(String(body.tool_name ?? ""), body.tool_input),
          success: resp.success ?? null,
        });
        return {};
      }
      case "PermissionRequest": {
        const sum = summary(String(body.tool_name ?? ""), body.tool_input);
        const { handle, promise } = addPendingHookPermission(
          sid,
          `${body.tool_name}: ${sum}`,
        );
        this.events.append(sid, "permission_request", {
          action: handle,
          tool_name: body.tool_name,
          summary: sum,
        });
        void this.twin.trigger(sid, `pede permissão: ${sum}`, "permission_request", meta);
        audit({ event: "hook_permission", session: meta.handle, action: handle, summary: sum });
        if (!this.remote().on) {
          drop(handle);
          return {};
        }
        const answer = await Promise.race([
          promise,
          new Promise<null>((r) => setTimeout(() => r(null), this.permHoldMs)),
        ]);
        if (answer === null) {
          this.events.append(sid, "permission_resolved", { action: handle, choice: "timeout" });
          return {}; // fall through to the Desktop prompt
        }
        const a = answer as { approved: boolean; choice: string };
        this.events.append(sid, "permission_resolved", {
          action: handle,
          choice: a.choice,
          by: "phone",
        });
        return a.approved ? { decision: "approve" } : PERM_BLOCK;
      }
      case "Stop": {
        const stopActive = body.stop_hook_active === true;
        this.events.append(sid, "stop", {
          last_assistant_message: body.last_assistant_message,
          stop_hook_active: stopActive,
        });
        // "turno concluído" fires once, only when the turn is actually let
        // to end — never on queued-instruction delivery nor on re-arms.
        const endTurn = () => {
          if (this.turnFired.has(sid)) return;
          this.turnFired.add(sid);
          void this.twin.trigger(sid, "turno concluído", "stop", meta);
        };
        const queued = this.drainQueue(sid, "stop", meta.handle);
        if (queued.length) {
          this.turnFired.delete(sid); // instruction continues the turn
          return this.blockWith(queued);
        }
        const r = this.remote();
        if (!r.on) {
          this.reArms.delete(sid);
          this.holdDeadline.delete(sid);
          endTurn();
          return {};
        }
        // absent mode: hold the turn open until an instruction arrives,
        // remote turns off, or the hard cap is reached; re-arm under the
        // curl timeout by blocking with a no-op just before ~840s.
        this.holds.add(sid);
        if (!this.holdDeadline.has(sid))
          this.holdDeadline.set(sid, Date.now() + r.maxHoldMinutes * 60_000);
        const deadline = this.holdDeadline.get(sid)!;
        const rearmAt = Date.now() + this.rearmMs;
        const done = () => {
          this.reArms.delete(sid);
          this.holdDeadline.delete(sid);
        };
        try {
          while (true) {
            if (this.queue.size(sid) > 0) {
              const items = this.drainQueue(sid, "stop", meta.handle);
              if (items.length) {
                done();
                this.turnFired.delete(sid);
                return this.blockWith(items);
              }
            }
            if (!this.remote().on) {
              done();
              endTurn();
              return {};
            }
            const now = Date.now();
            if (now >= deadline) {
              done();
              endTurn();
              return {};
            }
            if (now >= rearmAt) {
              const n = (this.reArms.get(sid) ?? 0) + 1;
              if (n > REARM_MAX) {
                done();
                endTurn();
                return {};
              }
              this.reArms.set(sid, n);
              return { decision: "block", reason: REARM_REASON };
            }
            await Bun.sleep(500);
          }
        } finally {
          this.holds.delete(sid);
        }
      }
      case "SessionEnd": {
        this.events.append(sid, "session_end", { reason: body.reason });
        void this.twin.trigger(sid, "sessão encerrada", "session_end", meta);
        if (this.queue.size(sid) > 0) void this.drainAfterSessionEnd(sid, cwd);
        return {};
      }
      default:
        return {};
    }
  }
}
