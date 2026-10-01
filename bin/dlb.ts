#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import {
  AUDIT_FILE,
  BRIDGE_LOG,
  BRIDGE_PID_FILE,
  TUNNEL_LOG,
  TUNNEL_PID_FILE,
  CONFIG_FILE,
  ensureDirs,
  pidAlive,
  readConfig,
  readPid,
  readState,
  readToken,
  removePid,
  writeConfig,
  writePid,
  writeState,
  writeToken,
  type CliConfig,
  type TunnelProvider,
} from "../src/cli/state.ts";
import { getTunnel } from "../src/cli/tunnel/index.ts";
import { callTool } from "../src/cli/client.ts";

const REPO = join(import.meta.dir, "..");
const VALID_PROVIDERS = ["quick", "tailscale", "cloudflare", "none"];

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

async function ask(q: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(def ? `${q} [${def}]: ` : `${q}: `);
    return a.trim() || def || "";
  } finally {
    rl.close();
  }
}

async function healthz(port: number): Promise<{ ok: boolean; lastRequestAt?: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()) as { ok: boolean; lastRequestAt?: string };
  } catch {
    return null;
  }
}

function printConnection(url: string, token: string): void {
  console.log(`\nMCP URL:  ${url}/mcp`);
  console.log(`Header:   Authorization: Bearer ${token}`);
}

// ---- commands ----

async function cmdSetup(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      workspaces: { type: "string" },
      port: { type: "string" },
      tunnel: { type: "string" },
      hostname: { type: "string" },
      name: { type: "string" },
      "public-url": { type: "string" },
    },
  });
  ensureDirs();
  const prev = readConfig();
  const workspaces =
    values.workspaces?.split(",").map((s) => s.trim()).filter(Boolean) ??
    (prev?.workspaces.length ? prev.workspaces : null) ??
    (await ask("Workspaces to expose (comma-separated absolute paths)", `/Users/${process.env.USER}/Documents/Workspace`)).split(",").map((s) => s.trim()).filter(Boolean);
  if (!workspaces.length || workspaces.some((w) => !w.startsWith("/")))
    die("workspaces must be absolute paths");
  const port =
    (values.port ? Number(values.port) : prev?.port) ??
    Number((await ask("Port", "8787")) || "8787");
  const provider =
    (values.tunnel as TunnelProvider | undefined) ??
    prev?.tunnel.provider ??
    ((await ask("Tunnel provider (quick|tailscale|cloudflare|none)", "quick")) as TunnelProvider);
  if (!VALID_PROVIDERS.includes(provider)) die(`invalid tunnel provider: ${provider}`);

  const cfg: CliConfig = {
    port,
    workspaces,
    turnTtlMin: prev?.turnTtlMin ?? 30,
    tunnel: {
      provider,
      name: values.name ?? prev?.tunnel.name,
      hostname: values.hostname ?? prev?.tunnel.hostname,
      publicUrl: values["public-url"] ?? prev?.tunnel.publicUrl,
    },
  };

  if (provider === "cloudflare") {
    const c = getTunnel(cfg);
    const chk = await c.check();
    if (!chk.ok) die(`${chk.hint}`, 2);
    if (!cfg.tunnel.name) cfg.tunnel.name = await ask("Cloudflare named tunnel name");
    if (!cfg.tunnel.hostname) cfg.tunnel.hostname = await ask("Public hostname (e.g. devin-mac.example.com)");
  } else if (provider === "tailscale") {
    const chk = await getTunnel(cfg).check();
    if (!chk.ok) die(`${chk.hint}`, 2);
  } else if (provider === "quick") {
    const chk = await getTunnel(cfg).check();
    if (!chk.ok) die(`${chk.hint}`, 2);
  }

  writeConfig(cfg);
  if (!readToken()) {
    writeToken(randomBytes(32).toString("hex"));
    console.log("generated new token");
  }
  console.log(`wrote ${CONFIG_FILE}`);
}

async function cmdStart(): Promise<void> {
  const cfg = readConfig() ?? die(`no config — run \`dlb setup\` first`);
  const token = readToken() ?? die("no token — run `dlb setup`");
  const oldPid = readPid(BRIDGE_PID_FILE);
  if (oldPid && pidAlive(oldPid)) die(`bridge already running (pid ${oldPid}) — use \`dlb restart\``);

  ensureDirs();
  const fd = openSync(BRIDGE_LOG, "a");
  const proc = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      BRIDGE_TOKEN: token,
      BRIDGE_WORKSPACES: cfg.workspaces.join(","),
      BRIDGE_PORT: String(cfg.port),
      BRIDGE_TURN_TTL_MIN: String(cfg.turnTtlMin),
    },
  });
  proc.unref();
  writePid(BRIDGE_PID_FILE, proc.pid!);

  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline) {
    const h = await healthz(cfg.port);
    if (h?.ok) {
      up = true;
      break;
    }
    await Bun.sleep(250);
  }
  if (!up) die(`bridge did not become healthy; see ${BRIDGE_LOG}`);
  console.log(`bridge up (pid ${proc.pid}, port ${cfg.port})`);

  const tunnel = getTunnel(cfg);
  const chk = await tunnel.check();
  if (!chk.ok) die(`tunnel provider check failed: ${chk.hint}`, 2);
  try {
    const { pid, url } = await tunnel.start(cfg.port);
    if (pid) writePid(TUNNEL_PID_FILE, pid);
    writeState({ publicUrl: url });
    printConnection(url, token);
  } catch (e) {
    die(`tunnel failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function cmdStop(): Promise<void> {
  const cfg = readConfig();
  if (cfg) await getTunnel(cfg).stop().catch(() => {});
  for (const [file, name] of [
    [TUNNEL_PID_FILE, "tunnel"],
    [BRIDGE_PID_FILE, "bridge"],
  ] as const) {
    const pid = readPid(file);
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      const end = Date.now() + 5000;
      while (pidAlive(pid) && Date.now() < end) await Bun.sleep(200);
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      console.log(`${name} stopped (pid ${pid})`);
    }
    removePid(file);
  }
}

async function cmdStatus(json: boolean): Promise<void> {
  const cfg = readConfig();
  const state = readState();
  const bridgePid = readPid(BRIDGE_PID_FILE);
  const tunnelPid = readPid(TUNNEL_PID_FILE);
  const bridgeAlive = pidAlive(bridgePid);
  const tunnelAlive = pidAlive(tunnelPid);
  const hz = cfg && bridgeAlive ? await healthz(cfg.port) : null;

  let lastAudit: string | null = null;
  try {
    const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n");
    lastAudit = lines[lines.length - 1] ?? null;
  } catch {}

  let mac: unknown = null;
  if (hz?.ok && cfg) {
    const token = readToken();
    if (token) {
      try {
        mac = await callTool(`http://127.0.0.1:${cfg.port}`, token, "mac_status");
      } catch (e) {
        mac = { error: String(e) };
      }
    }
  }

  const report = {
    bridge: { pid: bridgePid, alive: bridgeAlive, port: cfg?.port, healthy: Boolean(hz?.ok) },
    tunnel: {
      provider: cfg?.tunnel.provider,
      pid: tunnelPid,
      alive: cfg?.tunnel.provider === "none" ? null : tunnelAlive,
      publicUrl: state.publicUrl ?? null,
    },
    lastRequestAt: hz?.lastRequestAt ?? state.lastRequestAt ?? null,
    lastAudit,
    mac,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`bridge:  ${bridgeAlive ? `pid ${bridgePid} :${cfg?.port} ${hz?.ok ? "healthy" : "unhealthy"}` : "not running"}`);
    console.log(`tunnel:  ${cfg?.tunnel.provider ?? "?"}${tunnelPid ? ` pid ${tunnelPid} ${tunnelAlive ? "alive" : "dead"}` : ""} ${state.publicUrl ?? ""}`);
    console.log(`last req: ${report.lastRequestAt ?? "-"}`);
    if (lastAudit) console.log(`last audit: ${lastAudit.slice(0, 200)}`);
    if (mac && typeof mac === "object") console.log(`mac_status: ${JSON.stringify(mac)}`);
  }
  process.exit(bridgeAlive && hz?.ok ? 0 : 1);
}

async function cmdUrl(json: boolean): Promise<void> {
  const bridgePid = readPid(BRIDGE_PID_FILE);
  const state = readState();
  const token = readToken();
  if (!pidAlive(bridgePid) || !state.publicUrl || !token) die("not running");
  if (json) console.log(JSON.stringify({ url: `${state.publicUrl}/mcp`, token }));
  else printConnection(String(state.publicUrl), token);
}

async function cmdTokenRotate(): Promise<void> {
  const token = randomBytes(32).toString("hex");
  writeToken(token);
  console.log("token rotated");
  const pid = readPid(BRIDGE_PID_FILE);
  if (pidAlive(pid)) {
    await cmdStop();
    await cmdStart();
  }
  console.log(`Authorization: Bearer ${token}`);
  console.log("update this header in Devin Cloud → Customize → MCPs");
}

async function cmdLogs(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { follow: { type: "boolean", short: "f" }, tunnel: { type: "boolean" }, audit: { type: "boolean" } },
    allowPositionals: true,
  });
  const file = values.tunnel ? TUNNEL_LOG : values.audit ? AUDIT_FILE : BRIDGE_LOG;
  if (!existsSync(file)) die(`no log at ${file}`);
  if (values.follow) {
    const p = spawn("tail", ["-f", file], { stdio: "inherit" });
    process.on("SIGINT", () => {
      p.kill();
      process.exit(0);
    });
    await new Promise(() => {});
  } else {
    const p = Bun.spawnSync(["tail", "-n", "50", file]);
    process.stdout.write(p.stdout);
  }
}

async function cmdDoctor(): Promise<void> {
  let fail = false;
  const ok = (name: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!pass) fail = true;
  };

  const devinBin = process.env.DEVIN_BIN?.split(" ")[0] ?? "devin";
  const v = Bun.spawnSync([devinBin, "--version"]);
  ok("devin binary", v.exitCode === 0, v.stdout.toString().trim());

  const creds = `${process.env.HOME}/.local/share/devin/credentials.toml`;
  let hasKey = false;
  try {
    hasKey = /windsurf_api_key\s*=\s*"[^"]+"/.test(readFileSync(creds, "utf8"));
  } catch {}
  ok("credentials key", hasKey, hasKey ? "found" : "missing");

  const cfg = readConfig();
  ok("config.toml", Boolean(cfg && cfg.workspaces.length), cfg ? `port ${cfg.port}, ${cfg.workspaces.length} workspace(s)` : "run dlb setup");
  ok("token", (readToken()?.length ?? 0) >= 32);

  if (cfg) {
    // ACP round-trip with a 20s timeout
    try {
      const { AcpProcess } = await import("../src/acp/process.ts");
      const { loadConfig } = await import("../src/config.ts");
      const bc = loadConfig({
        BRIDGE_TOKEN: "d".repeat(40),
        BRIDGE_WORKSPACES: cfg.workspaces.join(","),
        DEVIN_API_KEY: process.env.DEVIN_API_KEY,
      });
      const acp = await Promise.race([
        AcpProcess.spawn(bc, cfg.workspaces[0]!),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000)),
      ]);
      acp.kill();
      ok("devin acp round-trip", true);
    } catch (e) {
      ok("devin acp round-trip", false, e instanceof Error ? e.message : String(e));
    }
    const chk = await getTunnel(cfg).check();
    ok(`tunnel provider (${cfg.tunnel.provider})`, chk.ok, chk.hint ?? "");
  }
  process.exit(fail ? 1 : 0);
}

// ---- main ----

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1).filter((a) => a !== "--json");
const sub = rest[0];
const wantsJson = argv.includes("--json");

switch (cmd) {
  case "setup":
    await cmdSetup(rest);
    break;
  case "start":
    await cmdStart();
    break;
  case "stop":
    await cmdStop();
    break;
  case "restart":
    await cmdStop();
    await cmdStart();
    break;
  case "status":
    await cmdStatus(wantsJson);
    break;
  case "url":
    await cmdUrl(wantsJson);
    break;
  case "token":
    if (sub !== "rotate") die("usage: dlb token rotate");
    await cmdTokenRotate();
    break;
  case "logs":
    await cmdLogs(rest);
    break;
  case "doctor":
    await cmdDoctor();
    break;
  default:
    console.log(
      "usage: dlb <setup|start|stop|restart|status|url|token rotate|logs|doctor>",
    );
    process.exit(cmd ? 1 : 0);
}
