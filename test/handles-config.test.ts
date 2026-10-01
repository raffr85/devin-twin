import "./_env.ts";
import { test, expect } from "bun:test";
import { HandleMap } from "../src/handles.ts";
import { loadConfig } from "../src/config.ts";

test("session handle is deterministic sha256-derived and reversible", () => {
  const h1 = new HandleMap();
  const h2 = new HandleMap();
  const a = h1.sessionHandle("sess-abc");
  expect(a).toBe(h1.sessionHandle("sess-abc"));
  expect(a).toBe(h2.sessionHandle("sess-abc"));
  expect(a).toMatch(/^s_[0-9a-f]{8}$/);
  expect(h1.sessionIdFor(a)).toBe("sess-abc");
  expect(h1.sessionIdFor("s_deadbeef")).toBeNull();
});

test("workspace handles round-trip", () => {
  const h = new HandleMap();
  const w = h.workspaceHandle("/Users/x/repo");
  expect(w).toMatch(/^w_[0-9a-f]{8}$/);
  expect(h.workspaceForHandle(w)).toBe("/Users/x/repo");
  expect(h.workspaceForHandle("w_deadbeef")).toBeNull();
});

function withExitSpy(env: Record<string, string | undefined>): string | null {
  const orig = process.exit;
  let msg: string | null = null;
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never;
  const origErr = console.error;
  console.error = (m?: unknown) => {
    msg = String(m);
  };
  try {
    loadConfig(env);
    return null;
  } catch {
    return msg;
  } finally {
    process.exit = orig;
    console.error = origErr;
  }
}

const base = {
  BRIDGE_TOKEN: "t".repeat(40),
  BRIDGE_WORKSPACES: "/tmp",
  DEVIN_API_KEY: "k",
};

test("config: valid env", () => {
  const cfg = loadConfig({ ...base, DEVIN_BIN: "bun /x/fake.ts" });
  expect(cfg.port).toBe(8787);
  expect(cfg.devinBin).toBe("bun");
  expect(cfg.devinArgs).toEqual(["/x/fake.ts"]);
});

test("config: missing/short token exits", () => {
  expect(withExitSpy({})).toMatch(/BRIDGE_TOKEN/);
  expect(withExitSpy({ ...base, BRIDGE_TOKEN: "short" })).toMatch(/BRIDGE_TOKEN/);
});

test("config: missing or relative workspaces exits", () => {
  expect(withExitSpy({ BRIDGE_TOKEN: base.BRIDGE_TOKEN })).toMatch(/BRIDGE_WORKSPACES/);
  expect(
    withExitSpy({ ...base, BRIDGE_WORKSPACES: "relative/dir" }),
  ).toMatch(/absolute/);
});
