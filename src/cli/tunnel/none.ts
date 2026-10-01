import type { TunnelHandle } from "./index.ts";
import type { CliConfig } from "../state.ts";

export function noneTunnel(cfg: CliConfig): TunnelHandle {
  return {
    async check() {
      return { ok: true };
    },
    async start(port) {
      return { url: cfg.tunnel.publicUrl ?? `http://127.0.0.1:${port}` };
    },
    async stop() {},
  };
}
