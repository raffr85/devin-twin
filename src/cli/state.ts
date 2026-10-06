import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_STATE_DIR = join(homedir(), ".local/share/devin-local-bridge");
export const STATE_DIR =
  process.env.TWIN_STATE_DIR ??
  process.env.DLB_STATE_DIR ??
  join(homedir(), ".local/share/devin-twin");

/** One-time rename ~/.local/share/devin-local-bridge → devin-twin. */
export function migrateLegacyStateDir(): void {
  if (process.env.TWIN_STATE_DIR || process.env.DLB_STATE_DIR) return;
  try {
    if (existsSync(LEGACY_STATE_DIR) && !existsSync(STATE_DIR)) {
      renameSync(LEGACY_STATE_DIR, STATE_DIR);
      console.error(`migrated state dir ${LEGACY_STATE_DIR} -> ${STATE_DIR}`);
    }
  } catch (e) {
    console.error(`state dir migration failed: ${e}`);
  }
}
export const CONFIG_FILE = join(STATE_DIR, "config.toml");
export const TOKEN_FILE = join(STATE_DIR, "token");
export const BRIDGE_PID_FILE = join(STATE_DIR, "bridge.pid");
export const TUNNEL_PID_FILE = join(STATE_DIR, "tunnel.pid");
export const STATE_FILE = join(STATE_DIR, "state.json");
export const AUDIT_FILE = join(STATE_DIR, "audit.jsonl");
export const HOOK_TOKEN_FILE = join(STATE_DIR, "hook_token");
export const REMOTE_FILE = join(STATE_DIR, "remote.json");
export const QUEUE_FILE = join(STATE_DIR, "queue.json");
export const TWINS_FILE = join(STATE_DIR, "twins.json");
export const EVENTS_DIR = join(STATE_DIR, "events");
export const LOGS_DIR = join(STATE_DIR, "logs");
export const BRIDGE_LOG = join(LOGS_DIR, "bridge.log");
export const TUNNEL_LOG = join(LOGS_DIR, "tunnel.log");

export type TunnelProvider = "quick" | "tailscale" | "cloudflare" | "none";

export type CliConfig = {
  port: number;
  hookPort: number;
  queueTtlMin: number;
  workspaces: string[];
  turnTtlMin: number;
  tunnel: {
    provider: TunnelProvider;
    name?: string;
    hostname?: string;
    publicUrl?: string;
  };
  push: {
    provider: "ntfy" | "none";
    server: string;
    topic: string;
  };
  twin: {
    maxAcuLimit: number;
    archiveOnEnd: boolean;
  };
  capture: {
    simulator: boolean;
    android: boolean;
  };
};

export function ensureDirs(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
}

export function readConfig(): CliConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  const raw = Bun.TOML.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  const tunnel = (raw.tunnel ?? {}) as Record<string, unknown>;
  const push = (raw.push ?? {}) as Record<string, unknown>;
  const twin = (raw.twin ?? {}) as Record<string, unknown>;
  const capture = (raw.capture ?? {}) as Record<string, unknown>;
  return {
    port: Number(raw.port ?? 8787),
    hookPort: Number(raw.hook_port ?? 8788),
    queueTtlMin: Number(raw.queue_ttl_min ?? 60),
    workspaces: (raw.workspaces as string[]) ?? [],
    turnTtlMin: Number(raw.turn_ttl_min ?? 30),
    tunnel: {
      provider: (tunnel.provider as TunnelProvider) ?? "quick",
      name: tunnel.name as string | undefined,
      hostname: tunnel.hostname as string | undefined,
      publicUrl: tunnel.public_url as string | undefined,
    },
    push: {
      provider: (push.provider as "ntfy" | "none") ?? "none",
      server: (push.server as string) ?? "https://ntfy.sh",
      topic: (push.topic as string) ?? "",
    },
    twin: {
      maxAcuLimit: Number(twin.max_acu_limit ?? 2),
      archiveOnEnd: (twin.archive_on_end as boolean) ?? true,
    },
    capture: {
      simulator: (capture.simulator as boolean) ?? true,
      android: (capture.android as boolean) ?? true,
    },
  };
}

export function writeConfig(cfg: CliConfig): void {
  ensureDirs();
  const ws = cfg.workspaces.map((w) => JSON.stringify(w)).join(", ");
  let out = `port = ${cfg.port}\nhook_port = ${cfg.hookPort}\nqueue_ttl_min = ${cfg.queueTtlMin}\nworkspaces = [${ws}]\nturn_ttl_min = ${cfg.turnTtlMin}\n\n[tunnel]\nprovider = "${cfg.tunnel.provider}"\n`;
  if (cfg.tunnel.name) out += `name = ${JSON.stringify(cfg.tunnel.name)}\n`;
  if (cfg.tunnel.hostname) out += `hostname = ${JSON.stringify(cfg.tunnel.hostname)}\n`;
  if (cfg.tunnel.publicUrl) out += `public_url = ${JSON.stringify(cfg.tunnel.publicUrl)}\n`;
  out += `\n[push]\nprovider = "${cfg.push.provider}"\nserver = "${cfg.push.server}"\ntopic = "${cfg.push.topic}"\n`;
  out += `\n[twin]\nmax_acu_limit = ${cfg.twin.maxAcuLimit}\narchive_on_end = ${cfg.twin.archiveOnEnd}\n`;
  out += `\n[capture]\nsimulator = ${cfg.capture.simulator}\nandroid = ${cfg.capture.android}\n`;
  writeFileSync(CONFIG_FILE, out);
}

export function readHookToken(): string | null {
  if (!existsSync(HOOK_TOKEN_FILE)) return null;
  const t = readFileSync(HOOK_TOKEN_FILE, "utf8").trim();
  return t || null;
}

export function writeHookToken(token: string): void {
  ensureDirs();
  writeFileSync(HOOK_TOKEN_FILE, token);
  chmodSync(HOOK_TOKEN_FILE, 0o600);
}

export type RemoteState = { on: boolean; maxHoldMinutes: number };

export function readRemote(): RemoteState {
  try {
    const r = JSON.parse(readFileSync(REMOTE_FILE, "utf8"));
    return { on: Boolean(r.on), maxHoldMinutes: Number(r.maxHoldMinutes ?? 720) };
  } catch {
    return { on: false, maxHoldMinutes: 720 };
  }
}

export function writeRemote(r: RemoteState): void {
  ensureDirs();
  writeFileSync(REMOTE_FILE, JSON.stringify(r));
}

export function readToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null;
  const t = readFileSync(TOKEN_FILE, "utf8").trim();
  return t || null;
}

export function writeToken(token: string): void {
  ensureDirs();
  writeFileSync(TOKEN_FILE, token);
  chmodSync(TOKEN_FILE, 0o600);
}

export function readPid(file: string): number | null {
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function writePid(file: string, pid: number): void {
  ensureDirs();
  writeFileSync(file, String(pid));
}

export function removePid(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readState(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(patch: Record<string, unknown>): void {
  ensureDirs();
  writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
}
