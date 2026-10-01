import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TunnelHandle } from "./index.ts";
import type { CliConfig } from "../state.ts";
import { spawnLogged, which } from "./util.ts";
import { TUNNEL_LOG } from "../state.ts";

export function cloudflareTunnel(cfg: CliConfig): TunnelHandle {
  return {
    async check() {
      if (!which("cloudflared"))
        return { ok: false, hint: "cloudflared not found — brew install cloudflared" };
      if (!existsSync(join(homedir(), ".cloudflared/cert.pem")))
        return {
          ok: false,
          hint: "not logged in — run: cloudflared tunnel login",
        };
      if (!cfg.tunnel.name || !cfg.tunnel.hostname)
        return { ok: false, hint: "config.toml needs tunnel.name and tunnel.hostname" };
      return { ok: true };
    },
    async start() {
      const pid = spawnLogged(["cloudflared", "tunnel", "run", cfg.tunnel.name!], TUNNEL_LOG);
      return { pid, url: `https://${cfg.tunnel.hostname}` };
    },
    async stop() {},
  };
}
