import type { TunnelHandle } from "./index.ts";
import { which } from "./util.ts";
import { existsSync } from "node:fs";

const APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function tailscaleBin(): string | null {
  return which("tailscale") ?? (existsSync(APP_BIN) ? APP_BIN : null);
}

function statusJson(): Record<string, unknown> | null {
  const bin = tailscaleBin();
  if (!bin) return null;
  try {
    const r = Bun.spawnSync([bin, "status", "--json"]);
    if (r.exitCode !== 0) return null;
    return JSON.parse(r.stdout.toString());
  } catch {
    return null;
  }
}

export function tailscaleDnsName(): string | null {
  const st = statusJson();
  const dns = (st?.Self as Record<string, unknown> | undefined)?.DNSName as string | undefined;
  return dns ? dns.replace(/\.$/, "") : null;
}

export function tailscaleTunnel(): TunnelHandle {
  return {
    async check() {
      if (!tailscaleBin())
        return {
          ok: false,
          hint: "tailscale not found — brew install --cask tailscale, then `tailscale up`",
        };
      const st = statusJson();
      if (st?.BackendState !== "Running")
        return { ok: false, hint: "tailscale not running — run `tailscale up`" };
      return { ok: true };
    },
    async start(port) {
      const bin = tailscaleBin()!;
      // Funnel only serves on ports 443/8443/10000 and must be enabled in tailnet ACL.
      const r = Bun.spawnSync([bin, "funnel", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
      if (r.exitCode !== 0) {
        throw new Error(`tailscale funnel failed: ${r.stderr.toString().trim()}`);
      }
      const dns = tailscaleDnsName();
      if (!dns) throw new Error("could not resolve tailscale DNS name");
      return { url: `https://${dns}` };
    },
    async stop() {
      const bin = tailscaleBin();
      if (bin) Bun.spawnSync([bin, "funnel", "reset"]);
    },
  };
}
