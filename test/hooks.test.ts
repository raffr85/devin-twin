import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { AcpPool } from "../src/acp/pool.ts";
import { HandleMap } from "../src/handles.ts";
import { startHttp } from "../src/http.ts";
import { EventStore } from "../src/events.ts";
import { InstructionQueue } from "../src/queue.ts";
import { HookRuntime } from "../src/hooks.ts";
import { TwinManager } from "../src/twin/manager.ts";
import type { Ctx } from "../src/mcp/server.ts";
import type { Fetcher } from "../src/twin/api.ts";

const TOKEN = "t".repeat(40);
const HOOK_TOK = "h".repeat(40);
const FAKE = join(import.meta.dir, "fake-acp-agent.ts");

let dir: string;
let cfg: Config;
let pool: AcpPool;
let ctx: Ctx;
let remote: { on: boolean; holdMinutes: number };
let server: ReturnType<typeof startHttp>;
let base: string;
let wsDir: string;

function hookBody(over: Record<string, unknown>) {
  return { hook_event_name: "Stop", session_id: "sess-1", prompt_id: "p1", ...over };
}

async function hook(event: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/hook?event=${event}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dlb-hook-token": HOOK_TOK,
      "x-dlb-cwd": wsDir,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dlb-hooks-"));
  wsDir = join(dir, "ws");
  process.env.FAKE_CWD = wsDir;
  cfg = loadConfig({
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_WORKSPACES: wsDir,
    DEVIN_BIN: `bun ${FAKE}`,
    DEVIN_API_KEY: "fake",
    BRIDGE_PORT: "0",
    BRIDGE_HOOK_TOKEN: HOOK_TOK,
    DLB_STATE_DIR: dir,
  });
  pool = new AcpPool(cfg);
  remote = { on: false, holdMinutes: 10 };
  const events = new EventStore(join(dir, "events"));
  const queue = new InstructionQueue(join(dir, "queue.json"));
  const twin = new TwinManager(join(dir, "twins.json"), null, { provider: "none", server: "", topic: "" }, {
    maxAcuLimit: 2,
    archiveOnEnd: true,
    isRemoteOn: () => remote.on,
  });
  const handles = new HandleMap();
  const hooks = new HookRuntime(events, queue, twin, handles, () => remote, 400);
  ctx = {
    cfg,
    pool,
    handles,
    events,
    queue,
    hooks,
    remote: () => remote,
    setRemote: (r) => Object.assign(remote, r),
    twin,
  };
  server = startHttp(ctx);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  pool.shutdown();
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("hook endpoint requires token", async () => {
  const r = await fetch(`${base}/hook?event=SessionStart`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dlb-cwd": wsDir },
    body: "{}",
  });
  expect(r.status).toBe(401);
});

test("hook endpoint rejects tunnel-forwarded requests", async () => {
  const r = await hook("SessionStart", hookBody({}), { "cf-ray": "abc" });
  expect(r.status).toBe(403);
});

test("hook ignores cwd outside allowlist", async () => {
  const r = await fetch(`${base}/hook?event=SessionStart`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dlb-hook-token": HOOK_TOK,
      "x-dlb-cwd": "/etc",
    },
    body: JSON.stringify(hookBody({ source: "startup" })),
  });
  expect(await r.json()).toEqual({});
  expect(ctx.events.list("sess-1").events).toHaveLength(0);
});

test("SessionStart/PostToolUse/UserPromptSubmit fold into live state", async () => {
  await hook("SessionStart", hookBody({ hook_event_name: "SessionStart", source: "startup" }));
  await hook("UserPromptSubmit", hookBody({ hook_event_name: "UserPromptSubmit", prompt: "do x" }));
  await hook("PostToolUse", hookBody({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "ls" },
    tool_response: { success: true, output: "ok", error: null },
  }));
  const live = ctx.events.live("sess-1");
  expect(live.state).toBe("running");
  expect(live.currentTool).toBe("exec");
  const { events, nextSince } = ctx.events.list("sess-1");
  expect(events.map((e) => e.kind)).toEqual(["session_start", "user_prompt", "tool"]);
  expect(nextSince).toBe(3);
});

test("Stop delivers queued instruction as block", async () => {
  ctx.queue.enqueue("sess-1", "create Y.txt");
  ctx.queue.enqueue("sess-1", "then Z.txt");
  const r = await hook("Stop", hookBody({ stop_hook_active: false }));
  const out = await r.json() as any;
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("create Y.txt");
  expect(out.reason).toContain("then Z.txt");
  const kinds = ctx.events.list("sess-1").events.map((e) => e.kind);
  expect(kinds.filter((k) => k === "instruction_delivered")).toHaveLength(2);
});

test("Stop with empty queue and remote off returns {}", async () => {
  const r = await hook("Stop", hookBody({ stop_hook_active: false }));
  expect(await r.json()).toEqual({});
});

test("Stop hold in remote mode returns when instruction arrives", async () => {
  remote.on = true;
  remote.holdMinutes = 0.05; // 3s
  setTimeout(() => ctx.queue.enqueue("sess-1", "late instruction"), 800);
  const start = Date.now();
  const r = await hook("Stop", hookBody({ stop_hook_active: false }));
  const out = await r.json() as any;
  expect(Date.now() - start).toBeGreaterThanOrEqual(700);
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("late instruction");
  remote.on = false;
});

test("PermissionRequest holds until mac_respond_permission approves", async () => {
  remote.on = true;
  const pendingPromise = hook("PermissionRequest", hookBody({
    hook_event_name: "PermissionRequest",
    tool_name: "exec",
    tool_input: { command: "rm -rf /tmp/x" },
    tool_use_id: "tu1",
  }));
  await Bun.sleep(200);
  const pending = (await import("../src/pending.ts")).listPending("sess-1");
  expect(pending).toHaveLength(1);
  expect(pending[0]!.kind).toBe("hook_permission");

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  const res = await client.callTool({
    name: "mac_respond_permission",
    arguments: { action: pending[0]!.handle, choice: "allow_once" },
  });
  expect((JSON.parse((res.content as [{ text: string }])[0].text)).ok).toBe(true);
  const r = await pendingPromise;
  expect(await r.json()).toEqual({ decision: "approve" });
  await client.close();
});

test("PermissionRequest deny maps to block", async () => {
  remote.on = true;
  const p = hook("PermissionRequest", hookBody({
    hook_event_name: "PermissionRequest",
    tool_name: "exec",
    tool_input: { command: "x" },
    tool_use_id: "tu2",
  }));
  await Bun.sleep(200);
  const { respond, listPending } = await import("../src/pending.ts");
  const pend = listPending("sess-1").find((x) => x.kind === "hook_permission")!;
  respond(pend.handle, { approved: false, choice: "reject" });
  expect(await (await p).json()).toEqual({
    decision: "block",
    reason: "Negado pelo usuário via celular",
  });
});

test("PermissionRequest timeout falls through ({})", async () => {
  remote.on = true;
  const p = hook("PermissionRequest", hookBody({
    hook_event_name: "PermissionRequest",
    tool_name: "exec",
    tool_input: { command: "slow" },
    tool_use_id: "tu3",
  }));
  expect(await (await p).json()).toEqual({});
});

test("UserPromptSubmit delivers queued instruction as additionalContext", async () => {
  ctx.queue.enqueue("sess-9", "from phone");
  const r = await hook("UserPromptSubmit", hookBody({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-9",
    prompt: "hi",
  }));
  const out = await r.json() as any;
  expect(out.hookSpecificOutput.additionalContext).toContain("from phone");
});

test("mac_get_events returns feed with cursor + local time", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  const handle = ctx.handles.sessionHandle("sess-1");
  const res = await client.callTool({
    name: "mac_get_events",
    arguments: { session: handle, limit: 2 },
  });
  const parsed = JSON.parse((res.content as [{ text: string }])[0].text);
  expect(parsed.events).toHaveLength(2);
  expect(parsed.nextSince).toBeGreaterThan(0);
  expect(parsed.localTime).toMatch(/^\d{2}:\d{2}$/);
  const res2 = await client.callTool({
    name: "mac_get_events",
    arguments: { session: handle, since: parsed.nextSince },
  });
  expect(JSON.parse((res2.content as [{ text: string }])[0].text).events).toHaveLength(0);
  await client.close();
});

// ---- twin manager with fake fetch ----

test("twin manager: creates once, coalesces, immediate permission, archives", async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fakeFetch: Fetcher = async (url, init) => {
    calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/sessions") && init.method === "POST") {
      return new Response(JSON.stringify({ session_id: "devin-abc", url: "https://app.devin.ai/x" }));
    }
    return new Response("{}");
  };
  const { DevinApi } = await import("../src/twin/api.ts");
  const api = new DevinApi("k", "org-1", fakeFetch);
  const remoteState = { on: true };
  const tm = new TwinManager(join(dir, "twins-fake.json"), api, { provider: "none", server: "", topic: "" }, {
    maxAcuLimit: 2,
    archiveOnEnd: true,
    isRemoteOn: () => remoteState.on,
  });
  const meta = { title: "T", cwd: "/tmp/x", handle: "s_1" };
  await tm.trigger("s1", "turno iniciado: a", "user_prompt", meta);
  const t1 = tm.list()["s1"];
  expect(t1!.devinId).toBe("devin-abc");
  expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/sessions"))).toHaveLength(1);
  // creates once
  await tm.trigger("s1", "turno iniciado: b", "user_prompt", meta);
  expect(calls.filter((c) => c.url.endsWith("/sessions") && c.method === "POST")).toHaveLength(1);
  const msgCalls = () => calls.filter((c) => c.url.includes("/messages"));
  expect(msgCalls()[0]!.body).toMatchObject({ message: "⟳ turno iniciado: a" });
  // second trigger coalesced (20s window) — schedule; permission_request immediate
  const before = msgCalls().length;
  await tm.trigger("s1", "pede permissão: rm", "permission_request", meta);
  expect(msgCalls().length).toBe(before + 1);
  // session_end archives
  await tm.trigger("s1", "sessão encerrada", "session_end", meta);
  expect(calls.some((c) => c.url.endsWith("/archive"))).toBe(true);
  expect(tm.list()["s1"]!.archived).toBe(true);
  // remote off → nothing
  remoteState.on = false;
  const n = calls.length;
  await tm.trigger("s2", "x", "user_prompt", meta);
  expect(calls.length).toBe(n);
});

test("ntfy push posts headers/body", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body),
    });
    return new Response("ok");
  }) as never;
  try {
    const { push } = await import("../src/push.ts");
    await push(
      { provider: "ntfy", server: "https://ntfy.sh", topic: "dlb-xyz" },
      { host: "MacBook", title: "Sessão", body: "pede permissão", click: "https://u", kind: "permission_request" },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(seen[0]!.url).toBe("https://ntfy.sh/dlb-xyz");
  expect(seen[0]!.headers.priority).toBe("high");
  expect(seen[0]!.headers.click).toBe("https://u");
  expect(seen[0]!.body).toBe("pede permissão");
});

test("hooks install merges into devin config preserving keys; status/uninstall work", async () => {
  const cfgPath = join(dir, "devin-config.json");
  writeFileSync(cfgPath, JSON.stringify({ devin: { org_id: "o1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/hook.sh Stop" }] }] } }));
  const env = { ...process.env, DLB_DEVIN_CONFIG: cfgPath, DLB_STATE_DIR: dir };
  const run = (...a: string[]) =>
    Bun.spawnSync(["bun", "bin/dlb.ts", ...a], { cwd: join(import.meta.dir, ".."), env });
  const st = run("hooks", "install");
  expect(st.exitCode).toBe(0);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(cfg.devin.org_id).toBe("o1");
  const stopArr = cfg.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
  expect(stopArr).toHaveLength(2); // ours + existing
  expect(cfg.hooks.PermissionRequest[0].hooks[0].timeout).toBe(610);
  expect(cfg.hooks.PermissionRequest[0].hooks[0].command).toContain("dlb-hook.sh PermissionRequest 600");
  expect(existsSync(`${cfgPath}.bak-dlb-${""}`)).toBe(false); // backup name has ts
  // rerun is idempotent
  run("hooks", "install");
  const cfg2 = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect((cfg2.hooks.Stop as unknown[]).length).toBe(2);
  // uninstall
  const un = run("hooks", "uninstall");
  expect(un.exitCode).toBe(0);
  const cfg3 = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect((cfg3.hooks.Stop as unknown[]).length).toBe(1);
  expect(cfg3.hooks.PermissionRequest).toBeUndefined();
});
