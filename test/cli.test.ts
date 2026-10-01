import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let S: typeof import("../src/cli/state.ts");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dlb-cli-"));
  process.env.DLB_STATE_DIR = dir;
  S = await import("../src/cli/state.ts");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mkCfg(over: Record<string, unknown> = {}) {
  return {
    port: 8787,
    workspaces: ["/tmp"],
    turnTtlMin: 30,
    tunnel: { provider: "quick" as const },
    push: { provider: "none" as const, server: "https://ntfy.sh", topic: "" },
    twin: { maxAcuLimit: 2, archiveOnEnd: true },
    ...over,
  };
}

test("config write/read round-trip", () => {
  const cfg = mkCfg({
    port: 9123,
    workspaces: ["/Users/x/a", "/Users/x/b c"],
    turnTtlMin: 45,
    tunnel: { provider: "quick" as const, hostname: "h.example.com" },
  });
  S.writeConfig(cfg);
  const back = S.readConfig()!;
  expect(back.port).toBe(9123);
  expect(back.workspaces).toEqual(cfg.workspaces);
  expect(back.turnTtlMin).toBe(45);
  expect(back.tunnel.provider).toBe("quick");
  expect(back.tunnel.hostname).toBe("h.example.com");
});

test("readConfig returns null when absent", () => {
  rmSync(S.CONFIG_FILE, { force: true });
  expect(S.readConfig()).toBeNull();
});

test("token file is written 0600 and round-trips", () => {
  S.writeToken("abc123");
  expect(S.readToken()).toBe("abc123");
  expect(statSync(S.TOKEN_FILE).mode & 0o777).toBe(0o600);
});

test("pidAlive detects live and dead pids", () => {
  expect(S.pidAlive(process.pid)).toBe(true);
  expect(S.pidAlive(999999)).toBe(false);
  expect(S.pidAlive(null)).toBe(false);
});

test("parseQuickTunnelUrl extracts trycloudflare URL from log", async () => {
  const { parseQuickTunnelUrl } = await import("../src/cli/tunnel/util.ts");
  const log = join(dir, "t.log");
  writeFileSync(log, "INF stuff\nINF |  https://abc-def-123.trycloudflare.com  |\nINF more");
  expect(parseQuickTunnelUrl(log)).toBe("https://abc-def-123.trycloudflare.com");
  writeFileSync(log, "nothing here");
  expect(parseQuickTunnelUrl(log)).toBeNull();
});

test("getTunnel selects provider", async () => {
  const { getTunnel } = await import("../src/cli/tunnel/index.ts");
  expect(typeof getTunnel(mkCfg({ tunnel: { provider: "quick" } })).start).toBe("function");
  expect(typeof getTunnel(mkCfg({ tunnel: { provider: "none" } })).start).toBe("function");
  const none = getTunnel(mkCfg({ tunnel: { provider: "none", publicUrl: "https://byo.example.com" } }));
  expect((await none.start(8787)).url).toBe("https://byo.example.com");
  const noneLocal = getTunnel(mkCfg({ tunnel: { provider: "none" } }));
  expect((await noneLocal.start(8787)).url).toBe("http://127.0.0.1:8787");
});

test("state.json write/read merge", () => {
  S.writeState({ publicUrl: "https://x.example.com" });
  S.writeState({ lastRequestAt: "2026-01-01T00:00:00Z" });
  const st = S.readState();
  expect(st.publicUrl).toBe("https://x.example.com");
  expect(st.lastRequestAt).toBe("2026-01-01T00:00:00Z");
});
