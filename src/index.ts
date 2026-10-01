import { loadConfig } from "./config.ts";
import { AcpPool } from "./acp/pool.ts";
import { HandleMap } from "./handles.ts";
import { startHttp } from "./http.ts";
import { EventStore } from "./events.ts";
import { InstructionQueue } from "./queue.ts";
import { HookRuntime } from "./hooks.ts";
import { TwinManager } from "./twin/manager.ts";
import { DevinApi, devinApiKey, devinOrgId } from "./twin/api.ts";
import {
  EVENTS_DIR,
  QUEUE_FILE,
  TWINS_FILE,
  readConfig,
  readRemote,
  writeRemote,
  type RemoteState,
} from "./cli/state.ts";

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
  },
);

const hooks = new HookRuntime(events, queue, twin, handles, () => readRemote());

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

console.log(`devin-local-bridge listening on http://127.0.0.1:${cfg.port}/mcp`);

process.on("SIGINT", () => {
  pool.shutdown();
  server.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  pool.shutdown();
  server.stop();
  process.exit(0);
});
