import type { EventStore } from "./events.ts";
import type { InstructionQueue } from "./queue.ts";
import type { TwinManager } from "./twin/manager.ts";
import type { HandleMap } from "./handles.ts";
import { addPendingHookPermission, drop } from "./pending.ts";
import { audit } from "./audit.ts";

export type RemoteReader = () => { on: boolean; holdMinutes: number };

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

export class HookRuntime {
  constructor(
    private events: EventStore,
    private queue: InstructionQueue,
    private twin: TwinManager,
    private handles: HandleMap,
    private remote: RemoteReader,
    private permHoldMs = 540_000,
    private queueTtlMs = 3_600_000,
  ) {}

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
        const queued = this.drainQueue(sid, "stop", meta.handle);
        if (queued.length) {
          return {
            decision: "block",
            reason: `Instrução do usuário enviada pelo celular:\n${queued.map((t) => `- ${t}`).join("\n")}`,
          };
        }
        const r = this.remote();
        if (r.on && !stopActive) {
          const end = Date.now() + r.holdMinutes * 60_000;
          while (Date.now() < end) {
            if (this.queue.size(sid) > 0) {
              const items = this.drainQueue(sid, "stop", meta.handle);
              if (items.length) {
                return {
                  decision: "block",
                  reason: `Instrução do usuário enviada pelo celular:\n${items.map((t) => `- ${t}`).join("\n")}`,
                };
              }
            }
            await Bun.sleep(500);
          }
        }
        // only now is the turn actually ending
        if (!stopActive) {
          void this.twin.trigger(sid, "turno concluído", "stop", meta);
        }
        return {};
      }
      case "SessionEnd": {
        this.events.append(sid, "session_end", { reason: body.reason });
        void this.twin.trigger(sid, "sessão encerrada", "session_end", meta);
        return {};
      }
      default:
        return {};
    }
  }
}
