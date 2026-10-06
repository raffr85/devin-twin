import "./_env.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatorCapture, AndroidCapture, type Runner } from "../src/capture.ts";
import { ArtifactWatcher, attachDirFor, attachRoot } from "../src/attach.ts";
import { EventStore } from "../src/events.ts";
import { InstructionQueue } from "../src/queue.ts";
import { HookRuntime } from "../src/hooks.ts";
import { TwinManager } from "../src/twin/manager.ts";
import { HandleMap } from "../src/handles.ts";
import { DevinApi, type Fetcher } from "../src/twin/api.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dlb-capture-"));
  process.env.DLB_STATE_DIR = dir;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test("touchesSimulator: command regex + xcodeproj cwd", () => {
  expect(SimulatorCapture.touchesSimulator("exec", { command: "xcrun simctl boot iPhone" }, "/x")).toBe(true);
  expect(SimulatorCapture.touchesSimulator("exec", { command: "xcodebuild -scheme App test" }, "/x")).toBe(true);
  expect(SimulatorCapture.touchesSimulator("exec", { command: "fastlane beta" }, "/x")).toBe(true);
  expect(SimulatorCapture.touchesSimulator("exec", { command: "ls -la" }, "/x")).toBe(false);
  const proj = join(dir, "proj");
  mkdirSync(join(proj, "App.xcodeproj"), { recursive: true });
  expect(SimulatorCapture.touchesSimulator("exec", { command: "ls" }, proj)).toBe(true);
  expect(SimulatorCapture.touchesSimulator("exec", { command: "ls" }, dir)).toBe(false);
});

test("touchesAndroid: command regex + gradle cwd", () => {
  expect(AndroidCapture.touchesAndroid("exec", { command: "adb shell input tap 1 2" }, "/x")).toBe(true);
  expect(AndroidCapture.touchesAndroid("exec", { command: "./gradlew assembleDebug" }, "/x")).toBe(true);
  expect(AndroidCapture.touchesAndroid("exec", { command: "ls" }, "/x")).toBe(false);
  const proj = join(dir, "aproj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "build.gradle.kts"), "");
  expect(AndroidCapture.touchesAndroid("exec", { command: "ls" }, proj)).toBe(true);
});

function simRunner(png: Uint8Array, device = "iPhone 15"): Runner {
  return async (cmd) => {
    if (cmd.includes("list"))
      return { code: 0, stdout: new TextEncoder().encode(JSON.stringify({ devices: [{ name: device, state: "Booted" }] })) };
    if (cmd.includes("screenshot")) {
      writeFileSync(cmd[cmd.length - 1]!, png);
      return { code: 0, stdout: new Uint8Array() };
    }
    return { code: 1, stdout: new Uint8Array() };
  };
}

test("shot dedup + throttle", async () => {
  let bytes = PNG;
  const cap = new SimulatorCapture(async (cmd, ms) => simRunner(bytes)(cmd, ms));
  expect(await cap.available()).toBe(true);
  expect(cap.deviceName()).toBe("iPhone 15");
  const a1 = await cap.shot("s1");
  expect(a1?.mime).toBe("image/png");
  expect(a1?.name.startsWith("sim-")).toBe(true);
  // same bytes → dedup
  expect(await cap.shot("s1")).toBeNull();
  // different bytes within 10 s → throttle
  bytes = Buffer.concat([PNG, Buffer.from("changed")]);
  expect(await cap.shot("s1")).toBeNull();
  // different bytes after the throttle window → artifact
  (cap as unknown as { perSid: Map<string, { lastAt: number }> }).perSid.get("s1")!.lastAt = Date.now() - 11_000;
  expect((await cap.shot("s1"))?.bytes.length).toBe(bytes.length);
});

test("available() false when the runner throws", async () => {
  const cap = new SimulatorCapture(async () => {
    throw new Error("no xcode");
  });
  expect(await cap.available()).toBe(false);
  const and = new AndroidCapture(async () => {
    throw new Error("no adb");
  });
  expect(await and.available()).toBe(false);
});

test("AndroidCapture.shot writes stdout to file", async () => {
  const cap = new AndroidCapture(async (cmd) => {
    if (cmd[1] === "devices")
      return { code: 0, stdout: new TextEncoder().encode("List of devices attached\nemulator-5554\tdevice\n") };
    return { code: 0, stdout: PNG };
  });
  expect(await cap.available()).toBe(true);
  expect(cap.deviceName()).toBe("emulator-5554");
  const a = await cap.shot("a1");
  expect(a?.name.startsWith("android-")).toBe(true);
  expect(Buffer.from(a!.bytes)).toEqual(PNG);
});

test("integration: PostToolUse sim touch → attachments POST + attachment_urls + screen headline; remote off → nothing", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fakeFetch: Fetcher = async (url, init) => {
    calls.push({ url: String(url), body: typeof init.body === "string" ? init.body : "<formdata>" });
    if (String(url).endsWith("/attachments"))
      return new Response(JSON.stringify({ url: "https://cdn.example.com/screen.png" }));
    if (String(url).endsWith("/playbooks"))
      return new Response(JSON.stringify({ playbook_id: "pb-1" }));
    if (String(url).endsWith("/sessions"))
      return new Response(JSON.stringify({ session_id: "devin-c", url: "u" }));
    return new Response("{}");
  };
  const remote = { on: false, maxHoldMinutes: 720 };
  const ev = new EventStore(join(dir, "ev-c"));
  const q = new InstructionQueue(join(dir, "q-c.json"));
  const tm = new TwinManager(join(dir, "twins-c.json"), new DevinApi("k", "o", fakeFetch),
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => remote.on, events: ev, lookupTitle: async () => null });
  const hooks = new HookRuntime(ev, q, tm, new HandleMap(), () => remote, 400);
  const heads: string[] = [];
  const orig = tm.trigger.bind(tm);
  tm.trigger = async (...args: Parameters<typeof orig>) => {
    heads.push(String(args[1]));
    return orig(...args);
  };
  let shots = 0;
  const fakeCap = {
    available: async () => true,
    deviceName: () => "iPhone 15",
    shot: async (sid: string) => {
      shots++;
      const p = join(attachDirFor(sid), "sim-test.png");
      writeFileSync(p, PNG);
      const old = new Date(Date.now() - 3000);
      utimesSync(p, old, old);
      return { path: p, name: "sim-test.png", mime: "image/png", bytes: new Uint8Array(PNG) };
    },
  };
  (hooks as unknown as Record<string, unknown>).sim = fakeCap;
  (hooks as unknown as Record<string, unknown>).attach = new ArtifactWatcher(attachRoot(), 0);

  const wsDir = join(dir, "ws-c");
  mkdirSync(wsDir, { recursive: true });
  const body = { session_id: "sess-cap", tool_name: "exec", tool_input: { command: "xcrun simctl boot iPhone" }, tool_response: { success: true } };

  // remote off → no capture at all
  await hooks.handle("PostToolUse", body, wsDir);
  await Bun.sleep(300);
  expect(shots).toBe(0);
  expect(calls.filter((c) => c.url.endsWith("/attachments")).length).toBe(0);

  // remote on → shot → upload → twin message with attachment_urls + screen headline
  remote.on = true;
  await hooks.handle("PostToolUse", body, wsDir);
  await Bun.sleep(400);
  expect(shots).toBe(1);
  expect(calls.filter((c) => c.url.endsWith("/attachments")).length).toBe(1);
  const msg = calls.find((c) => c.url.includes("/messages"));
  expect(JSON.parse(msg!.body!)).toMatchObject({ attachment_urls: ["https://cdn.example.com/screen.png"] });
  expect(heads.some((h) => h === "screen: iPhone 15")).toBe(true);
  expect(existsSync(join(dir, "ev-c", "sess-cap.jsonl"))).toBe(true);
});
