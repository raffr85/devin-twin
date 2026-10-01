import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../config.ts";
import type { AcpPool } from "../acp/pool.ts";
import type { SessionInfo } from "../acp/process.ts";
import { HandleMap } from "../handles.ts";
import { foldUpdates, summarize, deriveState } from "../history.ts";
import { listPending, pendingCount, respond } from "../pending.ts";
import { audit } from "../audit.ts";

export type Ctx = {
  cfg: Config;
  pool: AcpPool;
  handles: HandleMap;
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
        return {
          handle: ctx.handles.sessionHandle(s.sessionId),
          title: s.title,
          workspace: { handle: ctx.handles.workspaceHandle(w), name: basename(w) },
          state: owned ? "running" : d.state,
          isLocked: s.isLocked,
          updatedAt: s.updatedAt ?? null,
          ownedByBridge: owned,
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
      if (listed.isLocked && !ctx.pool.isOwned(sessionId)) {
        audit({ tool: "mac_send_message", session, outcome: "locked_by_other_client" });
        return toJson({ accepted: false, reason: "locked_by_other_client" });
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
    if (!pending || pending.kind !== "permission") {
      return errorResult(`unknown or expired action handle: ${action}`);
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

  return server;
}
