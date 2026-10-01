import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config.ts";
import type { AcpPool } from "../acp/pool.ts";
import type { SessionInfo } from "../acp/process.ts";
import type { EventStore } from "../events.ts";
import type { InstructionQueue } from "../queue.ts";
import type { HookRuntime } from "../hooks.ts";
import type { RemoteReader } from "../hooks.ts";
import type { TwinManager } from "../twin/manager.ts";
import type { RemoteState } from "../cli/state.ts";
import { HandleMap } from "../handles.ts";
import { foldUpdates, summarize, deriveState } from "../history.ts";
import { listPending, pendingCount, respond } from "../pending.ts";
import { audit } from "../audit.ts";

export type Ctx = {
  cfg: Config;
  pool: AcpPool;
  handles: HandleMap;
  events: EventStore;
  queue: InstructionQueue;
  hooks: HookRuntime;
  remote: RemoteReader;
  setRemote: (r: RemoteState) => void;
  twin: TwinManager;
};

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function workspaceOf(cfg: Config, cwd: string): string | null {
  const real = realpath(cwd);
  for (const w of cfg.workspaces) {
    const rw = realpath(w);
    if (real === rw || real.startsWith(rw.endsWith("/") ? rw : rw + "/")) return w;
  }
  return null;
}

function toJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

let cachedCliVersion: { bin: string; version: string } | undefined;

function cliVersion(devinBin: string): string {
  if (cachedCliVersion?.bin === devinBin) return cachedCliVersion.version;
  let version = "unknown";
  try {
    version = execSync(`${devinBin} --version`, { encoding: "utf8" }).trim();
  } catch {}
  cachedCliVersion = { bin: devinBin, version };
  return version;
}

async function listVisibleSessions(ctx: Ctx): Promise<SessionInfo[]> {
  const all = await ctx.pool.listSessions();
  return all.filter((s) => workspaceOf(ctx.cfg, s.cwd) !== null);
}

export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "devin-local-bridge", version: "0.1.0" });

  server.registerTool("mac_status", {
    description:
      "Health/status of the bridge to this Mac's local Devin sessions. Returns workspaces (by opaque handle), reader process liveness, counts of owned sessions and pending actions.",
  }, async () =>
    toJson({
      online: true,
      cliVersion: cliVersion(ctx.cfg.devinBin),
      readerProcessAlive: ctx.pool.readerAlive(),
      workspaces: ctx.cfg.workspaces.map((w) => ({
        handle: ctx.handles.workspaceHandle(w),
        name: basename(w),
      })),
      ownedSessions: ctx.pool.ownedSessionIds().size,
      pendingActions: pendingCount(),
    }),
  );

  server.registerTool("mac_list_sessions", {
    description:
      "List Devin sessions on this Mac (most recent first). Returns opaque handles — use them with mac_get_session / mac_send_message. No raw paths or ids are exposed.",
    inputSchema: {
      workspace: z.string().optional().describe("workspace handle from mac_status to filter by"),
      limit: z.number().int().min(1).max(50).optional().describe("max sessions, default 15"),
    },
  }, async ({ workspace, limit }) => {
    try {
      let sessions = await listVisibleSessions(ctx);
      if (workspace) {
        const w = ctx.handles.workspaceForHandle(workspace);
        if (!w) return errorResult(`unknown workspace handle: ${workspace}`);
        sessions = sessions.filter((s) => workspaceOf(ctx.cfg, s.cwd) === w);
      }
      sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      const out = sessions.slice(0, limit ?? 15).map((s) => {
        const w = workspaceOf(ctx.cfg, s.cwd)!;
        const owned = ctx.pool.isOwned(s.sessionId);
        const d = deriveState([], { isLocked: s.isLocked, updatedAt: s.updatedAt });
        if (s.title) ctx.events.setTitle(s.sessionId, s.title);
        const live = ctx.events.live(s.sessionId);
        return {
          handle: ctx.handles.sessionHandle(s.sessionId),
          title: s.title || live.title,
          workspace: { handle: ctx.handles.workspaceHandle(w), name: basename(w) },
          state: owned ? "running" : d.state,
          isLocked: s.isLocked,
          updatedAt: s.updatedAt ?? null,
          ownedByBridge: owned,
          ...(live.lastSeenAt ? { live } : {}),
        };
      });
      return toJson(out);
    } catch (e) {
      return errorResult(`list failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  server.registerTool("mac_get_session", {
    description:
      "Read a local Devin session's transcript (recent portion). Takes a session handle from mac_list_sessions. Safe on locked sessions.",
    inputSchema: {
      session: z.string().describe("session handle, e.g. s_1a2b3c4d"),
      maxItems: z.number().int().min(1).max(200).optional(),
    },
  }, async ({ session, maxItems }) => {
    const sessionId = ctx.handles.sessionIdFor(session);
    if (!sessionId) return errorResult(`unknown session handle: ${session}`);
    try {
      const listed = (await listVisibleSessions(ctx)).find((s) => s.sessionId === sessionId);
      if (!listed) return errorResult("session not found or outside allowed workspaces");
      let updates;
      let lockedByOther = false;
      if (ctx.pool.isOwned(sessionId)) {
        updates = ctx.pool.ownerUpdates(sessionId);
      } else {
        const r = await ctx.pool.loadTranscript(sessionId, listed.cwd);
        updates = r.updates;
        lockedByOther = r.lockedByOther;
      }
      const transcript = foldUpdates(updates);
      const d = deriveState(transcript, {
        isLocked: listed.isLocked,
        updatedAt: listed.updatedAt,
      });
      return toJson({
        handle: session,
        title: listed.title,
        state: ctx.pool.isOwned(sessionId) ? "running" : d.state,
        isLocked: listed.isLocked,
        ...(lockedByOther
          ? { readOnly: true, note: "open in another client; read-only" }
          : {}),
        lastActivity: d.lastActivity,
        transcript: summarize(transcript, { maxItems }),
        pendingActions: listPending(sessionId),
      });
    } catch (e) {
      return errorResult(`get failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  server.registerTool("mac_get_pending_actions", {
    description:
      "List pending permission requests / questions from sessions the bridge is currently driving. Respond via mac_respond_permission or mac_answer_question.",
  }, async () =>
    toJson(
      listPending().map((p) => ({
        handle: p.handle,
        session: ctx.handles.sessionHandle(p.sessionId),
        kind: p.kind,
        title: p.title,
        options: p.options,
        createdAt: p.createdAt,
      })),
    ),
  );

  server.registerTool("mac_send_message", {
    description:
      "Send a user message to a local Devin session and let it run on the Mac. Returns immediately; poll mac_get_session / mac_get_pending_actions for progress and permission requests. Fails with locked_by_other_client if the session is open in another client.",
    inputSchema: {
      session: z.string().describe("session handle"),
      text: z.string().describe("message to send as the user"),
    },
  }, async ({ session, text }) => {
    const sessionId = ctx.handles.sessionIdFor(session);
    if (!sessionId) return errorResult(`unknown session handle: ${session}`);
    try {
      const listed = (await listVisibleSessions(ctx)).find((s) => s.sessionId === sessionId);
      if (!listed) return errorResult("session not found or outside allowed workspaces");
      if (!ctx.pool.isOwned(sessionId)) {
        const hasHooks = ctx.events.hasRecentActivity(sessionId, 10 * 60_000);
        if (listed.isLocked || hasHooks) {
          ctx.queue.enqueue(sessionId, text);
          ctx.events.append(sessionId, "instruction_queued", { text });
          audit({ tool: "mac_send_message", session, outcome: "queued_for_hook" });
          return toJson({
            accepted: true,
            delivery: "queued_for_hook",
            note: "session is driven locally; instruction will be delivered on the next Stop/UserPromptSubmit hook",
          });
        }
      }
      const r = await ctx.pool.sendMessage(sessionId, listed.cwd, text);
      audit({ tool: "mac_send_message", session, text, outcome: r.ok ? "accepted" : r.reason });
      if (!r.ok) return toJson({ accepted: false, reason: r.reason });
      return toJson({ accepted: true, note: "turn running on Mac; call mac_get_session later" });
    } catch (e) {
      audit({ tool: "mac_send_message", session, outcome: "error" });
      return errorResult(`send failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  server.registerTool("mac_respond_permission", {
    description:
      "Answer a pending permission request. choice: 'reject' | 'allow_once' | 'allow_session'. Never grants unconditional allow-always.",
    inputSchema: {
      action: z.string().describe("pending action handle from mac_get_pending_actions"),
      choice: z.enum(["reject", "allow_once", "allow_session"]),
    },
  }, async ({ action, choice }) => {
    const pending = listPending().find((p) => p.handle === action);
    if (!pending || (pending.kind !== "permission" && pending.kind !== "hook_permission")) {
      return errorResult(`unknown or expired action handle: ${action}`);
    }
    if (pending.kind === "hook_permission") {
      const approved = choice !== "reject";
      const ok = respond(action, { approved, choice });
      audit({ tool: "mac_respond_permission", action, outcome: ok ? choice : "expired" });
      if (!ok) return errorResult("action expired");
      return toJson({
        ok: true,
        ...(choice === "allow_session" ? { note: "hook permissions are one-shot; approved once" } : {}),
      });
    }
    const wanted =
      choice === "reject"
        ? ["reject_once", "reject_always"]
        : choice === "allow_once"
          ? ["allow_once"]
          : ["allow_session"];
    const opt = pending.options.find((o) => wanted.includes(o.kind));
    const ok = opt
      ? respond(action, { outcome: { outcome: "selected", optionId: opt.id } })
      : respond(action, { outcome: { outcome: "cancelled" } });
    audit({ tool: "mac_respond_permission", action, outcome: ok ? `selected:${opt?.id ?? "cancelled"}` : "expired" });
    if (!ok) return errorResult("action expired");
    if (!opt) return toJson({ ok: true, note: "no matching option; cancelled" });
    return toJson({ ok: true });
  });

  server.registerTool("mac_answer_question", {
    description: "Answer a pending elicitation/question from a session with freeform text.",
    inputSchema: {
      action: z.string().describe("pending action handle"),
      answer: z.string(),
    },
  }, async ({ action, answer }) => {
    const pending = listPending().find((p) => p.handle === action);
    if (!pending || pending.kind !== "elicitation") {
      return errorResult(`unknown or expired action handle: ${action}`);
    }
    const ok = respond(action, { action: "accept", content: { answer } });
    audit({ tool: "mac_answer_question", action, outcome: ok ? "accepted" : "expired" });
    if (!ok) return errorResult("action expired");
    return toJson({ ok: true });
  });

  server.registerTool("mac_get_events", {
    description:
      "Live event feed of a local Devin session, sourced from lifecycle hooks on this Mac (works even when the session is open in Devin Desktop). Pass `since` = previous nextSince to get only new events.",
    inputSchema: {
      session: z.string().describe("session handle"),
      since: z.number().int().min(0).optional().describe("seq cursor; only events after this"),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async ({ session, since, limit }) => {
    const sessionId = ctx.handles.sessionIdFor(session);
    if (!sessionId) return errorResult(`unknown session handle: ${session}`);
    const { events, nextSince } = ctx.events.list(sessionId, since ?? 0, limit ?? 50);
    const title = await ctx.twin.resolveTitle(sessionId);
    const live = ctx.events.live(sessionId);
    const fmt = new Intl.DateTimeFormat("pt-BR", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
    return toJson({
      handle: session,
      title: title ?? live.title,
      live,
      events,
      nextSince,
      pendingActions: listPending(sessionId),
      localTime: fmt.format(new Date()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  server.registerTool("mac_remote_mode", {
    description:
      "Get or set remote mode: when on, Stop hooks on this Mac hold briefly waiting for queued phone instructions, and Devin Twins (cloud narrators) + push are enabled.",
    inputSchema: {
      on: z.boolean().optional().describe("set remote mode on/off; omit to just read"),
    },
  }, async ({ on }) => {
    const cur = ctx.remote();
    if (on === undefined) return toJson(cur);
    ctx.setRemote({ ...cur, on });
    audit({ tool: "mac_remote_mode", outcome: on ? "on" : "off" });
    return toJson({ ...cur, on });
  });

  return server;
}
