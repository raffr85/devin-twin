import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";
import { attachDirFor, type Artifact } from "./attach.ts";

export type RunResult = { code: number; stdout: Uint8Array };
export type Runner = (cmd: string[], timeoutMs: number) => Promise<RunResult>;

export const defaultRun: Runner = async (cmd, timeoutMs) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    return { code, stdout };
  } finally {
    clearTimeout(killer);
  }
};

const AVAIL_TTL_MS = 30_000;
const DIR_TTL_MS = 60_000;
const CMD_TIMEOUT_MS = 5_000;
const THROTTLE_MS = 10_000;

const dirCache = new Map<string, { at: number; names: string[] }>();
function dirNames(cwd: string): string[] {
  const c = dirCache.get(cwd);
  if (c && Date.now() - c.at < DIR_TTL_MS) return c.names;
  let names: string[] = [];
  try {
    names = readdirSync(cwd);
  } catch {}
  dirCache.set(cwd, { at: Date.now(), names });
  return names;
}

function execCommand(input: unknown): string {
  return String((input as Record<string, unknown> | undefined)?.command ?? "");
}
function inputCwd(input: unknown, cwd: string): string {
  const c = (input as Record<string, unknown> | undefined)?.cwd;
  return typeof c === "string" && c ? c : cwd;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export type CaptureBaseLike = {
  available(): Promise<boolean>;
  shot(sid: string): Promise<Artifact | null>;
  deviceName(): string | null;
};

abstract class CaptureBase {
  private perSid = new Map<string, { lastHash: string; lastAt: number }>();
  private availAt = 0;
  private availOk = false;
  private devName: string | null = null;

  constructor(protected run: Runner = defaultRun) {}

  deviceName(): string | null {
    return this.devName;
  }

  async available(): Promise<boolean> {
    if (Date.now() - this.availAt < AVAIL_TTL_MS) return this.availOk;
    try {
      const r = await this.run(this.probeCmd(), CMD_TIMEOUT_MS);
      const dev = r.code === 0 ? this.parseDevices(r.stdout) : null;
      this.availOk = dev !== null;
      this.devName = dev;
    } catch {
      this.availOk = false;
      this.devName = null;
    }
    this.availAt = Date.now();
    return this.availOk;
  }

  async shot(sid: string): Promise<Artifact | null> {
    const dir = attachDirFor(sid);
    const path = join(dir, `${this.prefix()}-${stamp()}.png`);
    try {
      if (!(await this.grab(path)) || !existsSync(path)) return null;
    } catch {
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
    if (!bytes.length) {
      rmSync(path, { force: true });
      return null;
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const st = this.perSid.get(sid) ?? { lastHash: "", lastAt: 0 };
    if (hash === st.lastHash || Date.now() - st.lastAt < THROTTLE_MS) {
      rmSync(path, { force: true });
      return null;
    }
    st.lastHash = hash;
    st.lastAt = Date.now();
    this.perSid.set(sid, st);
    // the screenshot is complete when the command exits; backdate mtime past
    // the watcher's settle window so it is collected on this scan
    const past = new Date(Date.now() - 2_500);
    try {
      utimesSync(path, past, past);
    } catch {}
    return { path, name: basename(path), mime: "image/png", bytes };
  }

  protected abstract probeCmd(): string[];
  protected abstract parseDevices(stdout: Uint8Array): string | null;
  protected abstract prefix(): string;
  protected abstract grab(path: string): Promise<boolean>;
}

export class SimulatorCapture extends CaptureBase {
  protected probeCmd(): string[] {
    return ["xcrun", "simctl", "list", "devices", "booted", "-j"];
  }

  protected parseDevices(stdout: Uint8Array): string | null {
    try {
      const j = JSON.parse(Buffer.from(stdout).toString("utf8")) as {
        devices?: unknown;
      };
      const d = j.devices;
      const list: Array<{ name?: string; state?: string }> = Array.isArray(d)
        ? d
        : d && typeof d === "object"
          ? Object.values(d as Record<string, Array<{ name?: string; state?: string }>>).flat()
          : [];
      return list.find((x) => x?.state === "Booted")?.name ?? list[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  protected prefix(): string {
    return "sim";
  }

  protected async grab(path: string): Promise<boolean> {
    const r = await this.run(
      ["xcrun", "simctl", "io", "booted", "screenshot", "--type=png", path],
      CMD_TIMEOUT_MS,
    );
    return r.code === 0;
  }

  static touchesSimulator(toolName: string, input: unknown, cwd: string): boolean {
    const cmd = execCommand(input);
    if (/\b(xcrun\s+simctl|xcodebuild|xcrun\s+devicectl|fastlane|xcrun\s+xctrace)\b/.test(cmd))
      return true;
    return dirNames(inputCwd(input, cwd)).some(
      (n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"),
    );
  }
}

export class AndroidCapture extends CaptureBase {
  protected probeCmd(): string[] {
    return ["adb", "devices"];
  }

  protected parseDevices(stdout: Uint8Array): string | null {
    const lines = Buffer.from(stdout).toString("utf8").split("\n");
    for (const l of lines.slice(1)) {
      const m = l.trim().match(/^(\S+)\s+device$/);
      if (m) return m[1]!;
    }
    return null;
  }

  protected prefix(): string {
    return "android";
  }

  protected async grab(path: string): Promise<boolean> {
    const r = await this.run(["adb", "exec-out", "screencap", "-p"], CMD_TIMEOUT_MS);
    if (r.code !== 0 || !r.stdout.length) return false;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, r.stdout);
    return true;
  }

  static touchesAndroid(toolName: string, input: unknown, cwd: string): boolean {
    const cmd = execCommand(input);
    if (/\b(adb|gradlew?|emulator)\b/.test(cmd)) return true;
    return dirNames(inputCwd(input, cwd)).some(
      (n) => n === "build.gradle" || n === "build.gradle.kts" || n === "settings.gradle",
    );
  }
}
