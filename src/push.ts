import { audit } from "./audit.ts";

export type PushConfig = { provider: "ntfy" | "none"; server: string; topic: string };

const TAGS: Record<string, string> = {
  permission_request: "warning",
  stop: "white_check_mark",
  session_end: "white_check_mark",
};

export async function push(
  cfg: PushConfig,
  opts: { host: string; title: string; body: string; click?: string; kind?: string },
): Promise<void> {
  if (cfg.provider !== "ntfy" || !cfg.topic) return;
  try {
    await fetch(`${cfg.server}/${cfg.topic}`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        Title: `[${opts.host}] ${opts.title}`.replace(/[^\x20-\x7E]/g, "?"),
        Click: opts.click ?? "",
        Priority: opts.kind === "permission_request" ? "high" : "default",
        Tags: TAGS[opts.kind ?? ""] ?? "hourglass",
      },
      body: opts.body,
    });
  } catch (e) {
    audit({ event: "push_failed", error: e instanceof Error ? e.message : String(e) });
  }
}
