#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import { homedir } from "node:os";
import {
  AUDIT_FILE,
  BRIDGE_LOG,
  BRIDGE_PID_FILE,
  HOOK_TOKEN_FILE,
  QUEUE_FILE,
  REMOTE_FILE,
  TWINS_FILE,
  TUNNEL_LOG,
  TUNNEL_PID_FILE,
  CONFIG_FILE,
  ensureDirs,
  pidAlive,
  readConfig,
  readHookToken,
  readPid,
  readRemote,
  readState,
  readToken,
  removePid,
  writeConfig,
  writeHookToken,
  writePid,
  writeRemote,
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
      "hook-port": { type: "string" },
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
    hookPort: values["hook-port"] ? Number(values["hook-port"]) : (prev?.hookPort ?? 8788),
    queueTtlMin: prev?.queueTtlMin ?? 60,
    workspaces,
    turnTtlMin: prev?.turnTtlMin ?? 30,
    tunnel: {
      provider,
      name: values.name ?? prev?.tunnel.name,
      hostname: values.hostname ?? prev?.tunnel.hostname,
      publicUrl: values["public-url"] ?? prev?.tunnel.publicUrl,
    },
    push: prev?.push ?? { provider: "none", server: "https://ntfy.sh", topic: "" },
    twin: prev?.twin ?? { maxAcuLimit: 2, archiveOnEnd: true },
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

  if (cfg.push.provider === "none" || !cfg.push.topic) {
    cfg.push = {
      provider: "ntfy",
      server: cfg.push.server || "https://ntfy.sh",
      topic: cfg.push.topic || `dlb-${randomBytes(6).toString("hex")}`,
    };
  }
  writeConfig(cfg);
  if (!readToken()) {
    writeToken(randomBytes(32).toString("hex"));
    console.log("generated new token");
  }
  if (!readHookToken()) {
    writeHookToken(randomBytes(32).toString("hex"));
    console.log("generated new hook token");
  }
  console.log(`wrote ${CONFIG_FILE}`);
}

// ---- hooks ----

const HOOK_SCRIPT = join(REPO, "hooks", "dlb-hook.sh");
const DEVIN_CONFIG =
  process.env.DLB_DEVIN_CONFIG ?? join(homedir(), ".config/devin/config.json");

function hooksBlock(): Record<string, Array<unknown>> {
  const cmd = (ev: string, maxTime = 3, timeout?: number) => ({
    hooks: [
      {
        type: "command",
        command: `${HOOK_SCRIPT} ${ev}${maxTime !== 3 ? ` ${maxTime}` : ""}`,
        ...(timeout ? { timeout } : {}),
      },
    ],
    ...(ev === "PermissionRequest" || ev === "PostToolUse" ? { matcher: "" } : {}),
  });
  return {
    SessionStart: [cmd("SessionStart")],
    UserPromptSubmit: [cmd("UserPromptSubmit")],
    PostToolUse: [cmd("PostToolUse")],
    PermissionRequest: [cmd("PermissionRequest", 600, 610)],
    Stop: [cmd("Stop", 900, 910)],
    SessionEnd: [cmd("SessionEnd")],
  };
}

function isDlbHookEntry(e: unknown): boolean {
  const hooks = (e as { hooks?: Array<{ command?: string }> }).hooks ?? [];
  return hooks.some((h) => typeof h.command === "string" && h.command.includes("dlb-hook.sh"));
}

async function cmdHooks(sub: string | undefined): Promise<void> {
  const cfg = JSON.parse(
    existsSync(DEVIN_CONFIG) ? readFileSync(DEVIN_CONFIG, "utf8") : "{}",
  ) as Record<string, unknown>;
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown[]>;

  if (sub === "status") {
    const installed = Object.values(hooks).some((arr) => arr.some(isDlbHookEntry));
    console.log(`hooks installed: ${installed}`);
    console.log(`hook token: ${readHookToken() ? "present" : "missing"}`);
    return;
  }
  if (sub === "install") {
    if (!readHookToken()) writeHookToken(randomBytes(32).toString("hex"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (existsSync(DEVIN_CONFIG))
      writeFileSync(`${DEVIN_CONFIG}.bak-dlb-${stamp}`, readFileSync(DEVIN_CONFIG));
    const ours = hooksBlock();
    for (const [ev, entries] of Object.entries(ours)) {
      const existing = (hooks[ev] ?? []).filter((e) => !isDlbHookEntry(e));
      hooks[ev] = [...existing, ...entries];
    }
    cfg.hooks = hooks;
    writeFileSync(DEVIN_CONFIG, JSON.stringify(cfg, null, 2));
    console.log(`installed hooks into ${DEVIN_CONFIG} (backup: config.json.bak-dlb-${stamp})`);
    return;
  }
  if (sub === "uninstall") {
    for (const ev of Object.keys(hooks)) {
      hooks[ev] = hooks[ev]!.filter((e) => !isDlbHookEntry(e));
      if (!hooks[ev]!.length) delete hooks[ev];
    }
    cfg.hooks = hooks;
    writeFileSync(DEVIN_CONFIG, JSON.stringify(cfg, null, 2));
    console.log("dlb hooks removed");
    return;
  }
  die("usage: dlb hooks install|uninstall|status");
}

// ---- remote ----

async function cmdRemote(sub: string | undefined, rest: string[]): Promise<void> {
  const { values } = parseArgs({ args: rest, options: { "hold-min": { type: "string" } } });
  const cur = readRemote();
  if (sub === "status" || !sub) {
    console.log(JSON.stringify(cur));
    return;
  }
  if (sub === "on" || sub === "off") {
    const next = {
      on: sub === "on",
      holdMinutes: values["hold-min"] ? Number(values["hold-min"]) : cur.holdMinutes,
    };
    writeRemote(next);
    console.log(`remote ${next.on ? "on" : "off"} (hold ${next.holdMinutes} min)`);
    return;
  }
  die("usage: dlb remote on|off|status [--hold-min N]");
}

// ---- twins ----

async function cmdTwin(sub: string | undefined, arg: string | undefined): Promise<void> {
  const rawTwins = existsSync(TWINS_FILE)
    ? (JSON.parse(readFileSync(TWINS_FILE, "utf8")) as Record<string, unknown>)
    : {};
  const list = Object.fromEntries(
    Object.entries(rawTwins).filter(([k]) => k !== "_playbook"),
  ) as Record<string, { devinId: string; url: string; archived: boolean; createdAt: string }>;
  if (sub === "list" || !sub) {
    const entries = Object.entries(list);
    if (!entries.length) console.log("no twins");
    for (const [sid, t] of entries) {
      console.log(`${t.archived ? "[archived] " : ""}${t.devinId}  ${t.url}  (${sid})`);
    }
    return;
  }
  if (sub === "archive") {
    const { DevinApi, devinApiKey, devinOrgId } = await import("../src/twin/api.ts");
    const key = devinApiKey();
    const org = devinOrgId();
    if (!key || !org) die("devin API credentials not found");
    const api = new DevinApi(key, org);
    const targets =
      arg === "all"
        ? Object.keys(list).filter((k) => !list[k]!.archived)
        : arg
          ? [arg]
          : die("usage: dlb twin archive <localSessionId|all>");
    for (const sid of targets) {
      const t = list[sid];
      if (!t) {
        console.log(`no twin for ${sid}`);
        continue;
      }
      if (!t.archived) {
        await api.archive(t.devinId);
        t.archived = true;
      }
      console.log(`archived ${t.devinId}`);
    }
    writeFileSync(TWINS_FILE, JSON.stringify({ ...rawTwins, ...list }, null, 2));
    return;
  }
  die("usage: dlb twin list|archive <localSessionId|all>");
}

// ---- push ----

async function cmdPush(sub: string | undefined): Promise<void> {
  const cfg = readConfig() ?? die("no config — run `dlb setup`");
  if (sub === "info" || !sub) {
    if (!cfg.push.topic) die("no ntfy topic — run `dlb setup` again");
    console.log(`provider: ntfy\nserver:   ${cfg.push.server}\ntopic:    ${cfg.push.topic}`);
    console.log(`\nsubscribe on your phone: ntfy app → + → ${cfg.push.topic} @ ${cfg.push.server}`);
    return;
  }
  if (sub === "test") {
    const { push } = await import("../src/push.ts");
    const { localHostName } = await import("../src/twin/manager.ts");
    await push(cfg.push, {
      host: localHostName(),
      title: "devin-local-bridge",
      body: "test notification — if you see this, push works",
      kind: "stop",
    });
    console.log(`sent test notification to ${cfg.push.server}/${cfg.push.topic}`);
    return;
  }
  die("usage: dlb push info|test");
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
      BRIDGE_HOOK_PORT: String(cfg.hookPort),
      BRIDGE_QUEUE_TTL_MIN: String(cfg.queueTtlMin),
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

  let twins: Record<string, { archived: boolean; url: string }> = {};
  try {
    const raw = JSON.parse(readFileSync(TWINS_FILE, "utf8"));
    twins = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "_playbook")) as typeof twins;
  } catch {}
  const remote = readRemote();
  let queuedInstructions = 0;
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8")) as Record<string, unknown[]>;
    for (const v of Object.values(q)) if (Array.isArray(v)) queuedInstructions += v.length;
  } catch {}
  const report = {
    bridge: { pid: bridgePid, alive: bridgeAlive, port: cfg?.port, healthy: Boolean(hz?.ok) },
    tunnel: {
      provider: cfg?.tunnel.provider,
      pid: tunnelPid,
      alive: cfg?.tunnel.provider === "none" ? null : tunnelAlive,
      publicUrl: state.publicUrl ?? null,
    },
    remote,
    queuedInstructions,
    twins: Object.fromEntries(
      Object.entries(twins)
        .filter(([k]) => k !== "_playbook")
        .map(([k, v]) => [k, { archived: v.archived, url: v.url }]),
    ),
    lastRequestAt: hz?.lastRequestAt ?? state.lastRequestAt ?? null,
    lastAudit,
    mac,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`bridge:  ${bridgeAlive ? `pid ${bridgePid} :${cfg?.port} ${hz?.ok ? "healthy" : "unhealthy"}` : "not running"}`);
    console.log(`tunnel:  ${cfg?.tunnel.provider ?? "?"}${tunnelPid ? ` pid ${tunnelPid} ${tunnelAlive ? "alive" : "dead"}` : ""} ${state.publicUrl ?? ""}`);
    console.log(`remote:  ${remote.on ? `on (hold ${remote.holdMinutes}m)` : "off"}  queued: ${queuedInstructions}`);
    const activeTwins = Object.values(twins).filter((t) => !t.archived).length;
    console.log(`twins:   ${activeTwins} active / ${Object.keys(twins).length} total`);
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
  case "hooks":
    await cmdHooks(sub);
    break;
  case "remote":
    await cmdRemote(sub, rest.slice(1));
    break;
  case "twin":
    await cmdTwin(sub, rest[1]);
    break;
  case "push":
    await cmdPush(sub);
    break;
  case "doctor":
    await cmdDoctor();
    break;
  default:
    console.log(
      "usage: dlb <setup|start|stop|restart|status|url|token rotate|logs|doctor|hooks install|uninstall|status|remote on|off|status|twin list|archive|push info|test>",
    );
    process.exit(cmd ? 1 : 0);
}
