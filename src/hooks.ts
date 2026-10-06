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
import { ArtifactWatcher } from "./attach.ts";
import { SimulatorCapture, AndroidCapture, type CaptureBaseLike } from "./capture.ts";

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
  private attach = new ArtifactWatcher();
  private sim: CaptureBaseLike = new SimulatorCapture();
  private andr: CaptureBaseLike = new AndroidCapture();
  private touchedSim = new Set<string>();
  private touchedAndroid = new Set<string>();
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
    private captureCfg: { simulator: boolean; android: boolean } = {
      simulator: true,
      android: true,
    },
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

  /** Upload new artifacts from the session's attach dir and trigger the twin. */
  private async pushArtifacts(
    sid: string,
    meta: { title?: string | null; cwd?: string | null; handle: string },
    headline?: string,
  ): Promise<void> {
    if (!this.remote().on) return; // nothing leaves the Mac unless absent mode is on
    try {
      const arts = await this.attach.collect(sid);
      if (!arts.length) return;
      const urls: string[] = [];
      const done: typeof arts = [];
      let firstImage: string | undefined;
      for (const a of arts) {
        const url = await this.twin.uploadArtifact(a.name, a.bytes, a.mime);
        if (!url) continue; // failed → retried on next scan
        urls.push(url);
        done.push(a);
        if (!firstImage && a.mime.startsWith("image/")) firstImage = url;
        this.events.append(sid, "artifact", {
          name: a.name,
          mime: a.mime,
          bytes: a.bytes.length,
          url,
        });
      }
      this.attach.markUploaded(sid, done);
      if (urls.length) {
        const first = done[0]!;
        const head =
          headline ??
          `${first.mime.startsWith("image/") ? "new image" : "new file"}: ${first.name}`;
        await this.twin.trigger(sid, head, "artifact", meta, urls, firstImage);
      }
    } catch (e) {
      audit({ event: "attach_scan_failed", error: String(e) });
    }
  }

  /** After a simulator/android touch, take a screen shot and push it. */
  private async maybeCapture(
    sid: string,
    meta: { title?: string | null; cwd?: string | null; handle: string },
    touched: { sim: boolean; android: boolean },
  ): Promise<void> {
    if (!this.remote().on) return;
    const cap =
      touched.sim && this.captureCfg.simulator && (await this.sim.available())
        ? { c: this.sim, fallback: "simulator" }
        : touched.android && this.captureCfg.android && (await this.andr.available())
          ? { c: this.andr, fallback: "android" }
          : null;
    if (!cap) return;
    try {
      const shot = await cap.c.shot(sid);
      if (shot)
        await this.pushArtifacts(
          sid,
          meta,
          `screen: ${cap.c.deviceName() ?? cap.fallback}`,
        );
    } catch (e) {
      audit({ event: "capture_failed", session: meta.handle, error: String(e) });
    }
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
        if (!this.remote().on) return {};
        const dir = this.attach.dirFor(sid);
        return {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext:
              `Screenshots of a booted iOS Simulator or Android device are captured automatically ` +
              `after simulator-related commands — no action needed; if the task involves the iOS ` +
              `app and no simulator is booted, boot one with \`xcrun simctl boot <device>\`. ` +
              `To show the user other images or a short log on their phone, save it into ${dir} ` +
              `(png/jpg/gif/webp/txt/log/md, ≤5 MB). Files there are uploaded to the user's Devin ` +
              `twin session automatically.`,
          },
        };
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
        const toolName = String(body.tool_name ?? "");
        this.events.append(sid, "tool", {
          tool_name: body.tool_name,
          summary: summary(toolName, body.tool_input),
          success: resp.success ?? null,
        });
        const touched = {
          sim: SimulatorCapture.touchesSimulator(toolName, body.tool_input, cwd),
          android: AndroidCapture.touchesAndroid(toolName, body.tool_input, cwd),
        };
        if (touched.sim) this.touchedSim.add(sid);
        if (touched.android) this.touchedAndroid.add(sid);
        if (touched.sim || touched.android) void this.maybeCapture(sid, meta, touched);
        else void this.pushArtifacts(sid, meta);
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
        const endTurn = (headline = "turno concluído") => {
          if (this.turnFired.has(sid)) return;
          this.turnFired.add(sid);
          void this.twin.trigger(sid, headline, "stop", meta);
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
        // announce the hold start once per real turn; if the session touched a
        // simulator/device, grab one final screen so it rides with "turno concluído"
        if (!stopActive) {
          const touched = {
            sim: this.touchedSim.has(sid),
            android: this.touchedAndroid.has(sid),
          };
          if (touched.sim || touched.android)
            await this.maybeCapture(sid, meta, touched);
          else void this.pushArtifacts(sid, meta);
          endTurn("turno concluído · aguardando suas instruções");
        } else void this.pushArtifacts(sid, meta);
        this.holds.add(sid);
        if (!this.holdDeadline.has(sid))
          this.holdDeadline.set(sid, Date.now() + r.maxHoldMinutes * 60_000);
        const deadline = this.holdDeadline.get(sid)!;
        const rearmAt = Date.now() + this.rearmMs;
        let lastScan = 0;
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
            const now2 = Date.now();
            if (now2 - lastScan >= 5_000) {
              lastScan = now2;
              await this.pushArtifacts(sid, meta);
            }
            await Bun.sleep(500);
          }
        } finally {
          this.holds.delete(sid);
        }
      }
      case "SessionEnd": {
        this.touchedSim.delete(sid);
        this.touchedAndroid.delete(sid);
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
