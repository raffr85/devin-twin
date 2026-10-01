import type { CliConfig } from "../state.ts";
import { quickTunnel } from "./quick.ts";
import { cloudflareTunnel } from "./cloudflare.ts";
import { tailscaleTunnel } from "./tailscale.ts";
import { noneTunnel } from "./none.ts";

export type TunnelHandle = {
  check(): Promise<{ ok: boolean; hint?: string }>;
  start(port: number): Promise<{ pid?: number; url: string }>;
  stop(): Promise<void>;
};

export function getTunnel(cfg: CliConfig): TunnelHandle {
  switch (cfg.tunnel.provider) {
    case "quick":
      return quickTunnel();
    case "cloudflare":
      return cloudflareTunnel(cfg);
    case "tailscale":
      return tailscaleTunnel();
    case "none":
      return noneTunnel(cfg);
  }
}
