import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "./config.ts";
import { createMcpServer, type Ctx } from "./mcp/server.ts";

const STATE_DIR =
  process.env.DLB_STATE_DIR ?? join(homedir(), ".local/share/devin-local-bridge");
const STATE_FILE = join(STATE_DIR, "state.json");

let lastRequestAt: string | null = null;
let lastStateWrite = 0;

function recordRequest(): void {
  lastRequestAt = new Date().toISOString();
  const now = Date.now();
  if (now - lastStateWrite < 10_000) return;
  lastStateWrite = now;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    let prev: Record<string, unknown> = {};
    if (existsSync(STATE_FILE)) prev = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    writeFileSync(STATE_FILE, JSON.stringify({ ...prev, lastRequestAt }));
  } catch {}
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const RATE_LIMIT = 60;
const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(token: string): boolean {
  const now = Date.now();
  let b = buckets.get(token);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(token, b);
  }
  b.count++;
  return b.count > RATE_LIMIT;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TUNNEL_HEADERS = ["cf-ray", "cf-connecting-ip", "x-forwarded-for"];

export function startHttp(ctx: Ctx): ReturnType<typeof Bun.serve> {
  const cfg: Config = ctx.cfg;
  return Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz" && req.method === "GET") {
        return json(200, { ok: true, lastRequestAt });
      }
      if (url.pathname === "/hook" && req.method === "POST") {
        // defense in depth: hooks only come from localhost; reject anything a
        // tunnel/proxy would add (bind is already 127.0.0.1)
        if (TUNNEL_HEADERS.some((h) => req.headers.has(h))) {
          return json(403, { error: "forbidden" });
        }
        const hookTok = req.headers.get("x-dlb-hook-token") ?? "";
        if (!cfg.hookToken || !hookTok || !tokenMatches(hookTok, cfg.hookToken)) {
          return json(401, { error: "unauthorized" });
        }
        const cwd = req.headers.get("x-dlb-cwd") ?? "";
        const inAllowlist = ctx.cfg.workspaces.some((w) => {
          try {
            const rw = realpathSync(w);
            const rc = realpathSync(cwd);
            return rc === rw || rc.startsWith(rw.endsWith("/") ? rw : rw + "/");
          } catch {
            return cwd === w || cwd.startsWith(w.endsWith("/") ? w : w + "/");
          }
        });
        if (!inAllowlist) return json(200, {});
        let body: Record<string, unknown> = {};
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return json(400, { error: "bad json" });
        }
        try {
          const out = await ctx.hooks.handle(url.searchParams.get("event") ?? "", body, cwd);
          return json(200, out);
        } catch (e) {
          return json(500, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (url.pathname !== "/mcp" || !["POST", "GET", "DELETE"].includes(req.method)) {
        return json(404, { error: "not found" });
      }
      recordRequest();
      const auth = req.headers.get("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!provided || !tokenMatches(provided, cfg.token)) {
        return json(401, { error: "unauthorized" });
      }
      if (rateLimited(provided)) {
        return json(429, { error: "rate limited" });
      }
      // Stateless mode: a fresh transport + server per request.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = createMcpServer(ctx);
      try {
        await server.connect(transport);
        return await transport.handleRequest(req);
      } finally {
        void transport.close().catch(() => {});
      }
    },
  });
}
