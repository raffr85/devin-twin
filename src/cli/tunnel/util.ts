import { existsSync, openSync, readFileSync } from "node:fs";

export function which(cmd: string): string | null {
  try {
    const r = Bun.spawnSync(["which", cmd]);
    const p = r.stdout.toString().trim();
    return r.exitCode === 0 && p ? p : null;
  } catch {
    return null;
  }
}

export function spawnLogged(argv: string[], logFile: string): number {
  const fd = openSync(logFile, "a");
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  proc.unref();
  return proc.pid;
}

export function parseQuickTunnelUrl(logFile: string): string | null {
  try {
    const m = readFileSync(logFile, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return m ? m[m.length - 1]! : null;
  } catch {
    return null;
  }
}

export async function waitFor(fn: () => string | null | Promise<string | null>, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(250);
  }
  return null;
}
