import { loadConfig } from "./config.ts";
import { AcpPool } from "./acp/pool.ts";
import { HandleMap } from "./handles.ts";
import { startHttp, startHookHttp } from "./http.ts";
import { expireStale } from "./pending.ts";
import { EventStore } from "./events.ts";
import { InstructionQueue } from "./queue.ts";
import { HookRuntime } from "./hooks.ts";
import { TwinManager } from "./twin/manager.ts";
import { DevinApi, devinApiKey, devinOrgId } from "./twin/api.ts";
import {
  EVENTS_DIR,
  migrateLegacyStateDir,
  QUEUE_FILE,
  TWINS_FILE,
  readConfig,
  readRemote,
  writeRemote,
  type RemoteState,
} from "./cli/state.ts";

migrateLegacyStateDir();

const cfg = loadConfig();
const pool = new AcpPool(cfg);
const handles = new HandleMap();
const events = new EventStore(EVENTS_DIR);
const queue = new InstructionQueue(QUEUE_FILE);

const cliCfg = readConfig();
const apiKey = cfg.apiKey;
const org = devinOrgId();
const api = apiKey && org ? new DevinApi(apiKey, org) : null;
const twin = new TwinManager(
  TWINS_FILE,
  api,
  cliCfg?.push ?? { provider: "none", server: "https://ntfy.sh", topic: "" },
  {
    maxAcuLimit: cliCfg?.twin.maxAcuLimit ?? 2,
    archiveOnEnd: cliCfg?.twin.archiveOnEnd ?? true,
    isRemoteOn: () => readRemote().on,
    events,
    lookupTitle: async (sid) =>
      (await pool.listSessions()).find((s) => s.sessionId === sid)?.title ?? null,
  },
);

const hooks = new HookRuntime(
  events,
  queue,
  twin,
  handles,
  () => readRemote(),
  540_000,
  cfg.queueTtlMs,
  { simulator: cfg.captureSimulator, android: cfg.captureAndroid },
);
hooks.drainOnEnd = async (sid, cwd, text) => {
  const r = await pool.sendMessage(sid, cwd, text);
  if (!r.ok) throw new Error(r.reason);
};

const hookServer = startHookHttp({
  cfg,
  pool,
  handles,
  events,
  queue,
  hooks,
  remote: () => readRemote(),
  setRemote: (r: RemoteState) => writeRemote(r),
  twin,
});

const server = startHttp({
  cfg,
  pool,
  handles,
  events,
  queue,
  hooks,
  remote: () => readRemote(),
  setRemote: (r: RemoteState) => writeRemote(r),
  twin,
});

setInterval(() => expireStale(cfg.turnTtlMs), 60_000).unref();

console.log(
  `devin-twin listening on http://127.0.0.1:${cfg.port}/mcp (hooks on :${cfg.hookPort})`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    pool.shutdown();
    server.stop();
    hookServer.stop();
    process.exit(0);
  });
}
