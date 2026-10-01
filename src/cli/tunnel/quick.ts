import type { TunnelHandle } from "./index.ts";
import { parseQuickTunnelUrl, spawnLogged, waitFor, which } from "./util.ts";
import { TUNNEL_LOG } from "../state.ts";

export function quickTunnel(): TunnelHandle {
  return {
    async check() {
      return which("cloudflared")
        ? { ok: true }
        : { ok: false, hint: "cloudflared not found — brew install cloudflared" };
    },
    async start(port) {
      const pid = spawnLogged(["cloudflared", "tunnel", "--url", `http://127.0.0.1:${port}`], TUNNEL_LOG);
      const url = await waitFor(() => parseQuickTunnelUrl(TUNNEL_LOG), 30_000);
      if (!url) throw new Error(`quick tunnel URL not found within 30s; see ${TUNNEL_LOG}`);
      return { pid, url };
    },
    async stop() {
      // process kill handled by caller via tunnel.pid
    },
  };
}
