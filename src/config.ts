import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  token: string;
  port: number;
  workspaces: string[];
  devinBin: string;
  devinArgs: string[];
  apiKey: string | null;
  turnTtlMs: number;
  hookToken: string | null;
  hookPort: number;
  queueTtlMs: number;
};

function readApiKeyFromCredentials(): string | null {
  const path = join(homedir(), ".local/share/devin/credentials.toml");
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const m = text.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const token = env.BRIDGE_TOKEN;
  if (!token || token.length < 32) {
    console.error("BRIDGE_TOKEN is required and must be at least 32 characters");
    process.exit(1);
  }
  const wsRaw = env.BRIDGE_WORKSPACES;
  if (!wsRaw) {
    console.error("BRIDGE_WORKSPACES is required (comma-separated absolute directories)");
    process.exit(1);
  }
  const workspaces = wsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (workspaces.length === 0 || workspaces.some((w) => !w.startsWith("/"))) {
    console.error("BRIDGE_WORKSPACES entries must be absolute paths");
    process.exit(1);
  }
  const port = Number(env.BRIDGE_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("BRIDGE_PORT must be a valid port");
    process.exit(1);
  }
  const hookPort = Number(env.BRIDGE_HOOK_PORT ?? "8788");
  if (!Number.isInteger(hookPort) || hookPort < 0 || hookPort > 65535) {
    console.error("BRIDGE_HOOK_PORT must be a valid port");
    process.exit(1);
  }
  const queueTtlMin = Number(env.BRIDGE_QUEUE_TTL_MIN ?? "60");
  if (!Number.isFinite(queueTtlMin) || queueTtlMin <= 0) {
    console.error("BRIDGE_QUEUE_TTL_MIN must be a positive number of minutes");
    process.exit(1);
  }
  const parts = (env.DEVIN_BIN ?? "devin").split(/\s+/).filter(Boolean);
  const devinBin = parts[0] ?? "devin";
  const devinArgs = parts.slice(1);
  const apiKey = env.DEVIN_API_KEY ?? readApiKeyFromCredentials();
  const ttlMin = Number(env.BRIDGE_TURN_TTL_MIN ?? "30");
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) {
    console.error("BRIDGE_TURN_TTL_MIN must be a positive number of minutes");
    process.exit(1);
  }
  let hookToken = env.BRIDGE_HOOK_TOKEN ?? null;
  if (!hookToken) {
    const dir =
      env.DLB_STATE_DIR ?? join(homedir(), ".local/share/devin-local-bridge");
    try {
      hookToken = readFileSync(join(dir, "hook_token"), "utf8").trim() || null;
    } catch {}
  }
  return {
    token,
    port,
    workspaces,
    devinBin,
    devinArgs,
    apiKey,
    turnTtlMs: ttlMin * 60_000,
    hookToken,
    hookPort,
    queueTtlMs: queueTtlMin * 60_000,
  };
}
