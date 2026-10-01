import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

const TOKEN = "test-token-" + "x".repeat(40);
const FAKE = join(import.meta.dir, "fake-acp-agent.ts");

let ctxCounter = 0;
export function makeCtx(
  cfg: Config,
  pool: AcpPool,
  handles = new HandleMap(),
  remote = { on: false, maxHoldMinutes: 720 },
  permHoldMs = 540_000,
): { ctx: Ctx; remote: { on: boolean; maxHoldMinutes: number } } {
  const i = ++ctxCounter;
  const events = new EventStore(join(dir, `ev-${i}`));
  const queue = new InstructionQueue(join(dir, `q-${i}.json`));
  const twin = new TwinManager(join(dir, `twins-${i}.json`), null, {
    provider: "none",
    server: "",
    topic: "",
  }, { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => remote.on, events, lookupTitle: async () => null });
  const hooks = new HookRuntime(events, queue, twin, handles, () => remote, permHoldMs);
  return {
    ctx: {
      cfg,
      pool,
      handles,
      events,
      queue,
      hooks,
      remote: () => remote,
      setRemote: (r) => Object.assign(remote, r),
      twin,
    },
    remote,
  };
}

let dir: string;
let answerFile: string;
let server: ReturnType<typeof startHttp>;
let pool: AcpPool;
let cfg: Config;
let base: string;
let ctx: Ctx;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dlb-"));
  process.env.DLB_STATE_DIR = dir;
  answerFile = join(dir, "answers.txt");
  process.env.FAKE_ANSWER_FILE = answerFile;
  process.env.FAKE_CWD = dir;
  cfg = loadConfig({
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_WORKSPACES: dir,
    DEVIN_BIN: `bun ${FAKE}`,
    DEVIN_API_KEY: "fake",
    BRIDGE_PORT: "0",
  });
  pool = new AcpPool(cfg);
  ctx = makeCtx(cfg, pool).ctx;
  server = startHttp(ctx);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  pool.shutdown();
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("healthz is unauthenticated", async () => {
  const r = await fetch(`${base}/healthz`);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true });
});

test("/mcp rejects missing or wrong bearer token", async () => {
  expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
  expect(
    (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-wrong-token-wrong" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
});

test("/mcp accepts the correct token (not 401)", async () => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(r.status).not.toBe(401);
});

test("rate limit: 61st authenticated request in a minute is 429", async () => {
  const token = TOKEN + "-rl";
  const cfg2 = { ...cfg, token };
  const pool2 = new AcpPool(cfg2);
  const srv = startHttp(makeCtx(cfg2, pool2).ctx);
  const b = `http://127.0.0.1:${srv.port}`;
  try {
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const r = await fetch(`${b}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      last = r.status;
      await r.arrayBuffer();
    }
    expect(last).toBe(429);
  } finally {
    pool2.shutdown();
    srv.stop();
  }
});

async function mcpClient() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client: Awaited<ReturnType<typeof mcpClient>>, name: string, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return { parsed: JSON.parse(text), isError: res.isError };
}

async function poll<T>(fn: () => Promise<T | null>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(200);
  }
  throw new Error("poll timed out");
}

test("integration: tools/list + session flow with fake agent", async () => {
  const client = await mcpClient();
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  expect(names).toEqual([
    "mac_answer_question",
    "mac_continue_session",
    "mac_get_events",
    "mac_get_pending_actions",
    "mac_get_session",
    "mac_list_sessions",
    "mac_remote_mode",
    "mac_respond_permission",
    "mac_send_message",
    "mac_status",
  ]);

  const status = (await call(client, "mac_status")).parsed;
  expect(status.online).toBe(true);
  expect(status.workspaces[0].handle).toMatch(/^w_/);

  const listed = (await call(client, "mac_list_sessions")).parsed;
  expect(listed).toHaveLength(2);
  const open = listed.find((s: { isLocked: boolean }) => !s.isLocked);
  const locked = listed.find((s: { isLocked: boolean }) => s.isLocked);
  expect(open.title).toBe("Fake open session");

  const got = (await call(client, "mac_get_session", { session: open.handle })).parsed;
  expect(got.transcript.map((i: { role: string }) => i.role)).toContain("user");
  expect(got.transcript.find((i: { role: string }) => i.role === "user").text).toBe("hello there");
  expect(got.transcript.find((i: { role: string }) => i.role === "tool").toolTitle).toBe(
    "Read file",
  );

  const lockRes = (await call(client, "mac_send_message", {
    session: locked.handle,
    text: "hi",
  })).parsed;
  // locked+idle sessions queue honestly and point at the continuation tool
  expect(lockRes).toEqual({
    accepted: true,
    delivery: "queued_idle_locked",
    note: "session is idle and open in Desktop; instruction queued — it will be delivered when the session next runs, or use mac_continue_session to continue it now in a new session",
  });

  // locked session still replays history before erroring -> read-only transcript
  const lockedGet = (await call(client, "mac_get_session", { session: locked.handle })).parsed;
  expect(lockedGet.readOnly).toBe(true);
  expect(lockedGet.note).toContain("read-only");
  expect(lockedGet.transcript.map((i: { role: string }) => i.role)).toEqual(["user", "agent"]);

  const send = (await call(client, "mac_send_message", { session: open.handle, text: "do it" }))
    .parsed;
  expect(send.accepted).toBe(true);

  const pending = await poll(async () => {
    const p = (await call(client, "mac_get_pending_actions")).parsed;
    return p.length ? p : null;
  });
  expect(pending[0].kind).toBe("permission");
  expect(pending[0].options.map((o: { id: string }) => o.id)).toContain("opt-allow-session");
  expect(
    pending[0].options.every(
      (o: { kind: string; id: string; label: string }) =>
        o.kind !== "allow_always" || /session/i.test(o.label + o.id),
    ),
  ).toBe(true);

  const resp = (
    await call(client, "mac_respond_permission", { action: pending[0].handle, choice: "allow_once" })
  ).parsed;
  expect(resp.ok).toBe(true);

  await poll(async () => {
    if (!existsSync(answerFile)) return null;
    const content = readFileSync(answerFile, "utf8");
    return content.includes("PERMISSION_ANSWER=opt-allow") ? content : null;
  });

  // turn finished -> owner released, pending cleared
  await poll(async () => {
    const g = (await call(client, "mac_get_session", { session: open.handle })).parsed;
    return g.state === "idle" ? g : null;
  });

  await client.close();
}, 60000);

test("turn TTL: hanging turn is cancelled, owner released, audited", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "dlb-ttl-"));
  const answerFile2 = join(dir2, "answers.txt");
  process.env.FAKE_ANSWER_FILE = answerFile2;
  process.env.FAKE_CWD = dir2;
  const cfg2 = loadConfig({
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_WORKSPACES: dir2,
    DEVIN_BIN: `bun ${FAKE}`,
    DEVIN_API_KEY: "fake",
    BRIDGE_PORT: "0",
    BRIDGE_TURN_TTL_MIN: "0.005", // 300ms
  });
  const pool2 = new AcpPool(cfg2);
  const handles2 = new HandleMap();
  const srv2 = startHttp(makeCtx(cfg2, pool2, handles2).ctx);
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${srv2.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } },
    );
    const client = new Client({ name: "ttl-test", version: "0" });
    await client.connect(transport);

    const call2 = async (name: string, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text);
    };

    const listed = await call2("mac_list_sessions");
    const open = listed.find((s: { isLocked: boolean }) => !s.isLocked);
    const send = await call2("mac_send_message", { session: open.handle, text: "HANG" });
    expect(send.accepted).toBe(true);
    expect(pool2.isOwned("fake-session-open")).toBe(true);

    const content = await poll(async () => {
      if (!existsSync(answerFile2)) return null;
      const c = readFileSync(answerFile2, "utf8");
      return c.includes("CANCELLED=fake-session-open") ? c : null;
    });
    expect(content).toContain("CANCELLED=fake-session-open");
    await poll(async () => (pool2.isOwned("fake-session-open") ? null : true));
    await client.close();
  } finally {
    process.env.FAKE_ANSWER_FILE = answerFile; // restore before removing dir2
    pool2.shutdown();
    srv2.stop();
    rmSync(dir2, { recursive: true, force: true });
  }
}, 30000);

test("mac_continue_session creates a new session for locked/idle only", async () => {
  const client = await mcpClient();
  const listed = (await call(client, "mac_list_sessions")).parsed;
  const locked = listed.find((s: { isLocked: boolean }) => s.isLocked);
  const open = listed.find((s: { isLocked: boolean }) => !s.isLocked);

  const res = (await call(client, "mac_continue_session", {
    session: locked.handle,
    instruction: "keep going",
  })).parsed;
  expect(res.newSession).toMatch(/^s_/);
  expect(res.title).toContain("(continuação)");
  // the new session was created via session/new and prompted with context+instruction
  const content = await poll(async () => {
    const c = readFileSync(answerFile, "utf8");
    const m = c.match(/PROMPT=(fake-new-\d+)=(.*)/);
    return m?.[2]?.includes("keep going") ? m : null;
  });
  expect(content[2]!).toContain("Continuação da sessão local");
  expect(content[2]).toContain("Instrução do usuário");
  // twin alias recorded (no twin exists yet → no-op, but must not throw)
  const recs = (ctx.twin as unknown as { twins: Record<string, { aliases?: string[] }> }).twins;
  expect(recs).toBeDefined();
}, 20000);

test("narrator playbook body explains delivery modes", async () => {
  const { NARRATOR_BODY } = await import("../src/twin/manager.ts");
  expect(NARRATOR_BODY).toContain("queued_idle_locked");
  expect(NARRATOR_BODY).toContain("mac_continue_session");
  expect(NARRATOR_BODY).toContain("continuar");
  expect(NARRATOR_BODY).toContain("hook_live");
  expect(NARRATOR_BODY).toContain("acp_now");
});
