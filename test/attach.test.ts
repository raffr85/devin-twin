import "./_env.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactWatcher } from "../src/attach.ts";
import { EventStore } from "../src/events.ts";
import { InstructionQueue } from "../src/queue.ts";
import { HookRuntime } from "../src/hooks.ts";
import { TwinManager } from "../src/twin/manager.ts";
import { HandleMap } from "../src/handles.ts";
import { DevinApi, type Fetcher } from "../src/twin/api.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dlb-attach-"));
  process.env.DLB_STATE_DIR = dir;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

test("collect picks new allowed files, once", async () => {
  const w = new ArtifactWatcher(join(dir, "att1"));
  const d = w.dirFor("s1");
  writeFileSync(join(d, "shot.png"), PNG);
  writeFileSync(join(d, "notes.txt"), "hello");
  const a1 = await w.collect("s1");
  expect(a1.map((a) => a.name).sort()).toEqual(["notes.txt", "shot.png"]);
  expect(a1.find((a) => a.name === "shot.png")!.mime).toBe("image/png");
  // second collect: nothing new (marked uploaded)
  w.markUploaded("s1", a1);
  expect(await w.collect("s1")).toEqual([]);
  // a new file afterwards is picked up
  writeFileSync(join(d, "later.log"), "x");
  const a2 = await w.collect("s1");
  expect(a2.map((a) => a.name)).toEqual(["later.log"]);
});

test("collect rejects symlink, oversize, wrong extension", async () => {
  const w = new ArtifactWatcher(join(dir, "att2"));
  const d = w.dirFor("s2");
  writeFileSync(join(dir, "outside.png"), PNG);
  symlinkSync(join(dir, "outside.png"), join(d, "link.png"));
  writeFileSync(join(d, "big.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
  writeFileSync(join(d, "evil.exe"), PNG);
  writeFileSync(join(d, "ok.png"), PNG);
  const arts = await w.collect("s2");
  expect(arts.map((a) => a.name)).toEqual(["ok.png"]);
});

test("collect caps at 4 per scan, rest next time", async () => {
  const w = new ArtifactWatcher(join(dir, "att3"));
  const d = w.dirFor("s3");
  for (let i = 0; i < 6; i++) writeFileSync(join(d, `f${i}.txt`), `n${i}`);
  const a1 = await w.collect("s3");
  expect(a1.length).toBe(4);
  w.markUploaded("s3", a1);
  const a2 = await w.collect("s3");
  expect(a2.length).toBe(2);
});

test("text artifacts are redacted", async () => {
  const w = new ArtifactWatcher(join(dir, "att4"));
  const d = w.dirFor("s4");
  writeFileSync(join(d, "keys.log"), "api_key=sk-abc123def456ghi789 ok");
  const arts = await w.collect("s4");
  const text = Buffer.from(arts[0]!.bytes).toString("utf8");
  expect(text).toContain("«redacted»");
  expect(text).not.toContain("sk-abc123def456ghi789");
});

test("upload → twin message carries attachment_urls; artifact event; ntfy Attach header", async () => {
  const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = [];
  const fakeFetch: Fetcher = async (url, init) => {
    calls.push({ url: String(url), body: typeof init.body === "string" ? init.body : "<formdata>", headers: init.headers as Record<string,string> });
    if (String(url).endsWith("/attachments"))
      return new Response(JSON.stringify({ url: "https://cdn.example.com/a.png" }));
    if (String(url).endsWith("/playbooks"))
      return new Response(JSON.stringify({ playbook_id: "pb-1" }));
    if (String(url).endsWith("/sessions"))
      return new Response(JSON.stringify({ session_id: "devin-x", url: "u" }));
    return new Response("{}");
  };
  const pushes: Array<Record<string, string>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("ntfy.test")) {
      pushes.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("ok");
    }
    return realFetch(url as string, init);
  }) as typeof fetch;
  try {
    const remote = { on: true, maxHoldMinutes: 720 };
    const ev = new EventStore(join(dir, "ev-a"));
    const q = new InstructionQueue(join(dir, "q-a.json"));
    const tm = new TwinManager(join(dir, "twins-a.json"), new DevinApi("k", "o", fakeFetch),
      { provider: "ntfy", server: "https://ntfy.test", topic: "t" },
      { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => remote.on, events: ev, lookupTitle: async () => null });
    const hooks = new HookRuntime(ev, q, tm, new HandleMap(), () => remote, 400);
    const wsDir = join(dir, "ws");
    // write an artifact into the session's attach dir
    const adir = hooks["attach"].dirFor("sess-art");
    writeFileSync(join(adir, "ui.png"), PNG);
    await hooks.handle("PostToolUse", { session_id: "sess-art", tool_name: "write", tool_input: {} }, wsDir);
    await Bun.sleep(300);
    const post = calls.find((c) => c.url.endsWith("/attachments"));
    expect(post).toBeTruthy();
    const msg = calls.find((c) => c.url.includes("/messages"));
    expect(JSON.parse(msg!.body!)).toMatchObject({ attachment_urls: ["https://cdn.example.com/a.png"] });
    const artEv = ev.list("sess-art", 0, 50).events.find((e) => e.kind === "artifact");
    expect(artEv).toMatchObject({ data: { name: "ui.png", url: "https://cdn.example.com/a.png" } });
    expect(pushes[0]?.Attach).toBe("https://cdn.example.com/a.png");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("403 disables uploads for the process", async () => {
  let n = 0;
  const fakeFetch: Fetcher = async (url) => {
    n++;
    return new Response("denied", { status: 403 });
  };
  const remote = { on: true, maxHoldMinutes: 720 };
  const tm = new TwinManager(join(dir, "twins-403.json"), new DevinApi("k", "o", fakeFetch),
    { provider: "none", server: "", topic: "" },
    { maxAcuLimit: 2, archiveOnEnd: true, isRemoteOn: () => remote.on });
  expect(await tm.uploadArtifact("a.png", PNG, "image/png")).toBeNull();
  expect(await tm.uploadArtifact("b.png", PNG, "image/png")).toBeNull();
  expect(n).toBe(1); // second call short-circuits
});
