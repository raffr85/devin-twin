import { loadConfig } from "./config.ts";
import { AcpPool } from "./acp/pool.ts";
import { HandleMap } from "./handles.ts";
import { startHttp } from "./http.ts";

const cfg = loadConfig();
const pool = new AcpPool(cfg);
const handles = new HandleMap();
const server = startHttp({ cfg, pool, handles });

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
