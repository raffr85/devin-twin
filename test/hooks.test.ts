import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { AcpPool } from "../src/acp/pool.ts";
import { HandleMap } from "../src/handles.ts";
import { startHttp, startHookHttp } from "../src/http.ts";
import { EventStore } from "../src/events.ts";
import { InstructionQueue } from "../src/queue.ts";
import { HookRuntime } from "../src/hooks.ts";
import { TwinManager } from "../src/twin/manager.ts";
import type { Ctx } from "../src/mcp/server.ts";
import type { Fetcher } from "../src/twin/api.ts";

async function poll<T>(fn: () => Promise<T | null>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(150);
  }
  throw new Error("poll timeout");
}

const TOKEN = "t".repeat(40);
const HOOK_TOK = "h".repeat(40);
const FAKE = join(import.meta.dir, "fake-acp-agent.ts");

let dir: string;
let cfg: Config;
let pool: AcpPool;
let ctx: Ctx;
let remote: { on: boolean; maxHoldMinutes: number };
let server: ReturnType<typeof startHttp>;
let hookServer: ReturnType<typeof startHookHttp>;
let base: string;
let hookBase: string;
let wsDir: string;

function hookBody(over: Record<string, unknown>) {
  return { hook_event_name: "Stop", session_id: "sess-1", prompt_id: "p1", ...over };
}

async function hook(event: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${hookBase}/hook?event=${event}`, {
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
  process.env.DLB_STATE_DIR = dir;
  wsDir = join(dir, "ws");
  mkdirSync(wsDir, { recursive: true });
  process.env.FAKE_CWD = wsDir;
  cfg = loadConfig({
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_WORKSPACES: wsDir,
    DEVIN_BIN: `bun ${FAKE}`,
    DEVIN_API_KEY: "fake",
    BRIDGE_PORT: "0",
    BRIDGE_HOOK_PORT: "0",
    BRIDGE_HOOK_TOKEN: HOOK_TOK,
    DLB_STATE_DIR: dir,
  });
  pool = new AcpPool(cfg);
  remote = { on: false, maxHoldMinutes: 720 };
  const events = new EventStore(join(dir, "events"));
  const queue = new InstructionQueue(join(dir, "queue.json"));
  const twin = new TwinManager(join(dir, "twins.json"), null, { provider: "none", server: "", topic: "" }, {
    maxAcuLimit: 2,
    archiveOnEnd: true,
    isRemoteOn: () => remote.on,
    events,
    lookupTitle: async () => null,
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
  hookServer = startHookHttp(ctx);
  base = `http://127.0.0.1:${server.port}`;
  hookBase = `http://127.0.0.1:${hookServer.port}`;
});

afterAll(() => {
  pool.shutdown();
  server.stop();
  hookServer.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("hook endpoint requires token", async () => {
  const r = await fetch(`${hookBase}/hook?event=SessionStart`, {
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
  const r = await fetch(`${hookBase}/hook?event=SessionStart`, {
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
  remote.maxHoldMinutes = 0.05; // 3s
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
    if (url.endsWith("/playbooks") && init.method === "POST") {
      return new Response(JSON.stringify({ playbook_id: "pb-1", body: (JSON.parse(String(init.body))).body }));
    }
    if (/\/playbooks\//.test(url) && init.method === "GET") {
      return new Response(JSON.stringify({ playbook_id: "pb-1", body: "stale" }));
    }
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
    events: new EventStore(join(dir, "ev-twin")),
    lookupTitle: async () => null,
  });
  const meta = { title: "T", cwd: "/tmp/x", handle: "s_1" };
  await tm.trigger("s1", "turno iniciado: a", "user_prompt", meta);
  const t1 = tm.list()["s1"];
  expect(t1!.devinId).toBe("devin-abc");
  const sessionCreates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/sessions"));
  expect(sessionCreates).toHaveLength(1);
  // playbook created once, twin uses it, prompt is the short glyph line
  expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/playbooks"))).toHaveLength(1);
  expect(sessionCreates[0]!.body).toMatchObject({ playbook_id: "pb-1", prompt: "⟳ s_1 · T" });
  // creates once
  await tm.trigger("s1", "turno iniciado: b", "user_prompt", meta);
  expect(calls.filter((c) => c.url.endsWith("/sessions") && c.method === "POST")).toHaveLength(1);
  expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/playbooks"))).toHaveLength(1);
  const msgCalls = () => calls.filter((c) => c.url.includes("/messages"));
  expect(msgCalls()[0]!.body).toMatchObject({ message: "⟳" });
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

test("title resolution: prompt fallback when ACP has no title", async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fakeFetch: Fetcher = async (url, init) => {
    calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/playbooks") && init.method === "POST")
      return new Response(JSON.stringify({ playbook_id: "pb-t" }));
    if (url.endsWith("/sessions") && init.method === "POST") {
      return new Response(JSON.stringify({ session_id: "devin-t2", url: "https://app.devin.ai/y" }));
    }
    return new Response("{}");
  };
  const { DevinApi } = await import("../src/twin/api.ts");
  const ev = new EventStore(join(dir, "ev-title"));
  ev.append("sid-t", "session_start", { cwd: "/tmp" });
  ev.append("sid-t", "user_prompt", { prompt: "create `A.txt`\nwith stuff   please" });
  const tm = new TwinManager(join(dir, "twins-title.json"), new DevinApi("k", "o", fakeFetch),
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => true, events: ev, lookupTitle: async () => null });
  await tm.trigger("sid-t", "h", "user_prompt", { title: null, cwd: "/tmp/x", handle: "s_t" });
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/sessions"))!;
  expect((create.body as { title: string }).title).toBe("[MacBook-Pro-3] create A.txt with stuff please");
});

test("title resolution: ACP lookup caches + refresh on stop", async () => {
  const ev = new EventStore(join(dir, "ev-title2"));
  ev.append("sid-r", "user_prompt", { prompt: "fallback title" });
  let callsToLookup = 0;
  const tm = new TwinManager(join(dir, "twins-t2.json"), null,
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => false, events: ev,
      lookupTitle: async () => { callsToLookup++; return callsToLookup === 1 ? "" : "Real Title"; } });
  expect(await tm.resolveTitle("sid-r")).toBe("fallback title");
  // ACP title arrives later: re-lookup (unset cache) and refresh both pick it up
  expect(await tm.resolveTitle("sid-r", true)).toBe("Real Title");
  expect(await tm.resolveTitle("sid-r")).toBe("Real Title"); // now cached
  expect(ev.live("sid-r").title).toBe("Real Title");
});

test("Stop with queued instruction does not post 'turno concluído' trigger", async () => {
  const posts: string[] = [];
  const fakeFetch: Fetcher = async (url, init) => {
    if (init.method === "POST" && String(url).includes("/messages"))
      posts.push(String(JSON.parse(String(init.body)).message));
    if (String(url).endsWith("/playbooks") && init.method === "POST")
      return new Response(JSON.stringify({ playbook_id: "pb-s" }));
    if (String(url).endsWith("/sessions") && init.method === "POST")
      return new Response(JSON.stringify({ session_id: "devin-t3", url: "u" }));
    return new Response("{}");
  };
  const { DevinApi } = await import("../src/twin/api.ts");
  const ev = new EventStore(join(dir, "ev-stop"));
  const q = new InstructionQueue(join(dir, "q-stop.json"));
  const rstate = { on: true, maxHoldMinutes: 0.01 };
  const tm = new TwinManager(join(dir, "twins-stop.json"), new DevinApi("k", "o", fakeFetch),
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => rstate.on, events: ev, lookupTitle: async () => null });
  const hm = new HandleMap();
  const hooks = new HookRuntime(ev, q, tm, hm, () => rstate, 100);
  q.enqueue("sid-s", "do more");
  const out = await hooks.handle("Stop", { session_id: "sid-s", stop_hook_active: false }, wsDir);
  expect((out as { decision: string }).decision).toBe("block");
  await Bun.sleep(50);
  expect(posts).toHaveLength(0); // turn continues — no trigger to the twin
  // next real Stop (empty queue) does trigger
  const out2 = await hooks.handle("Stop", { session_id: "sid-s", stop_hook_active: false }, wsDir);
  expect(out2).toEqual({});
  await Bun.sleep(50);
  expect(posts).toEqual(["⟳"]);
});

test("playbook updated when stored sha is stale", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fakeFetch: Fetcher = async (url, init) => {
    calls.push({ method: init.method ?? "GET", url });
    if (/playbooks\//.test(url) && init.method === "GET")
      return new Response(JSON.stringify({ playbook_id: "pb-old", body: "old" }));
    if (String(url).endsWith("/sessions") && init.method === "POST")
      return new Response(JSON.stringify({ session_id: "devin-x", url: "u" }));
    return new Response("{}");
  };
  const { DevinApi } = await import("../src/twin/api.ts");
  const file = join(dir, "twins-pb.json");
  writeFileSync(file, JSON.stringify({ _playbook: { id: "pb-old", sha: "stale" } }));
  const tm = new TwinManager(file, new DevinApi("k", "o", fakeFetch),
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => true,
      events: new EventStore(join(dir, "ev-pb")), lookupTitle: async () => null });
  await tm.trigger("s9", "h", "user_prompt", { title: "T", cwd: "/tmp", handle: "s_9" });
  expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/playbooks/pb-old"))).toBe(true);
  expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/playbooks"))).toBe(false);
});

test("/hook is not served on the public MCP port", async () => {
  const r = await fetch(`${base}/hook?event=Stop`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dlb-hook-token": HOOK_TOK,
      "x-dlb-cwd": wsDir,
    },
    body: "{}",
  });
  expect(r.status).toBe(404);
});

test("expired queued instructions are dropped with instruction_expired", async () => {
  const ev = new EventStore(join(dir, "ev-exp"));
  const q = new InstructionQueue(join(dir, "q-exp.json"));
  const rstate = { on: false, maxHoldMinutes: 0 };
  const tm = new TwinManager(join(dir, "tw-exp.json"), null,
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => rstate.on, events: ev, lookupTitle: async () => null });
  const hooks = new HookRuntime(ev, q, tm, new HandleMap(), () => rstate, 100, 50); // 50ms ttl
  q.enqueue("sid-e", "stale instruction");
  await Bun.sleep(80);
  const out = await hooks.handle("Stop", { session_id: "sid-e", stop_hook_active: false }, wsDir);
  expect(out).toEqual({});
  const kinds = ev.list("sid-e").events.map((e) => e.kind);
  expect(kinds).toContain("instruction_expired");
  expect(kinds).not.toContain("instruction_delivered");
});

test("redactSecrets masks common secret shapes", async () => {
  const { redactSecrets } = await import("../src/redact.ts");
  expect(redactSecrets("api_key=abc123xyz rest")).toBe("api_key=«redacted» rest");
  expect(redactSecrets("Authorization: Bearer tok123")).toBe("Authorization: «redacted»");
  expect(redactSecrets("sk-AbCdEfGh1234567890")).toBe("«redacted»");
  expect(redactSecrets("ghp_abcdefghijklmnop")).toBe("«redacted»");
  expect(redactSecrets("cog_abcdef1234567890")).toBe("«redacted»");
  expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("«redacted»");
  expect(redactSecrets("deadbeef".repeat(5))).toBe("«redacted»");
  expect(redactSecrets("plain text, no secrets")).toBe("plain text, no secrets");
});

// ---------- absent mode: indefinite hold, re-arm, remote-off release ----------

test("Stop hold releases when remote mode turns off; healthz reports holds", async () => {
  const { events, queue, twin, handles } = ctx;
  const local = { on: true, maxHoldMinutes: 720 };
  const h = new HookRuntime(events, queue, twin, handles, () => local, 400);
  const p = h.handle("Stop", { session_id: "sess-rel", stop_hook_active: false }, wsDir);
  await Bun.sleep(50);
  expect(h.isHolding("sess-rel")).toBe(true);
  const z = await fetch(`${hookBase}/healthz`);
  // ctx.hooks is the shared runtime; our local one isn't registered — check via isHolding
  expect(((await z.json()) as { ok: boolean }).ok).toBe(true);
  local.on = false;
  const out = await p;
  expect(out).toEqual({});
  expect(h.isHolding("sess-rel")).toBe(false);
});

test("Stop re-arm: returns noop block then keeps holding with stop_hook_active", async () => {
  const { events, queue, twin, handles } = ctx;
  const local = { on: true, maxHoldMinutes: 720 };
  const h = new HookRuntime(events, queue, twin, handles, () => local, 400);
  h.rearmMs = 200;
  const out1 = (await h.handle("Stop", { session_id: "sess-rm", stop_hook_active: false }, wsDir)) as {
    decision: string; reason: string;
  };
  expect(out1.decision).toBe("block");
  expect(out1.reason).toContain("modo ausente");
  // re-armed Stop re-enters the hold; an instruction arriving is delivered
  const p2 = h.handle("Stop", { session_id: "sess-rm", stop_hook_active: true }, wsDir);
  await Bun.sleep(50);
  expect(h.isHolding("sess-rm")).toBe(true);
  queue.enqueue("sess-rm", "oi from phone");
  const out2 = (await p2) as { decision: string; reason: string };
  expect(out2.decision).toBe("block");
  expect(out2.reason).toContain("oi from phone");
  expect(h.isHolding("sess-rm")).toBe(false);
});

test("Stop hold hard cap ends turn and triggers completion once", async () => {
  const posts: string[] = [];
  const fakeFetch: Fetcher = async (url, init) => {
    if (init.method === "POST" && String(url).includes("/messages"))
      posts.push(String(JSON.parse(String(init.body)).message));
    if (String(url).endsWith("/playbooks") && init.method === "POST")
      return new Response(JSON.stringify({ playbook_id: "pb-c" }));
    if (String(url).endsWith("/sessions") && init.method === "POST")
      return new Response(JSON.stringify({ session_id: "devin-c", url: "u" }));
    return new Response("{}");
  };
  const { DevinApi } = await import("../src/twin/api.ts");
  const { events, queue, handles } = ctx;
  const local = { on: true, maxHoldMinutes: 0.005 }; // ~300ms
  const tm = new TwinManager(join(dir, "twins-cap.json"), new DevinApi("k", "o", fakeFetch),
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => local.on, events, lookupTitle: async () => null });
  const h = new HookRuntime(events, queue, tm, handles, () => local, 400);
  const out = await h.handle("Stop", { session_id: "sess-cap", stop_hook_active: false }, wsDir);
  expect(out).toEqual({});
  await Bun.sleep(50);
  expect(posts).toEqual(["⟳"]);
  // a second stop of the same turn (stop_hook_active) doesn't re-trigger
  await h.handle("Stop", { session_id: "sess-cap", stop_hook_active: true }, wsDir);
  await Bun.sleep(50);
  expect(posts.filter((m) => m === "⟳").length).toBe(1);
});

test("SessionEnd drains queued instructions through the ACP pool", async () => {
  const answerFile = join(dir, `answers-${Date.now()}.txt`);
  process.env.FAKE_ANSWER_FILE = answerFile;
  try {
    const { events, queue, twin, handles } = ctx;
    const local = { on: false, maxHoldMinutes: 720 };
    const h = new HookRuntime(events, queue, twin, handles, () => local, 400);
    h.drainOnEnd = async (sid, cwd, text) => {
      const r = await pool.sendMessage(sid, cwd, text);
      if (!r.ok) throw new Error(r.reason);
    };
    queue.enqueue("fake-session-open", "drained on end");
    const out = await h.handle("SessionEnd", { session_id: "fake-session-open", reason: "exit" }, wsDir);
    expect(out).toEqual({});
    const content = await poll(async () => {
      if (!existsSync(answerFile)) return null;
      const c = readFileSync(answerFile, "utf8");
      return c.includes("PROMPT=fake-session-open=drained on end") ? c : null;
    });
    expect(content).toContain("PROMPT=fake-session-open=drained on end");
    // respond to its permission so the pool releases it
    const { listPending, respond } = await import("../src/pending.ts");
    const p = await poll(
      async () => listPending("fake-session-open").find((x) => x.kind === "permission") ?? null,
    );
    await respond(p.handle, "opt-allow-session");
    await poll(async () => (pool.isOwned("fake-session-open") ? null : true));
  } finally {
    delete process.env.FAKE_ANSWER_FILE;
  }
}, 30000);
