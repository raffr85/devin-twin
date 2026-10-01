import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactData } from "./redact.ts";

export type EvKind =
  | "session_start"
  | "user_prompt"
  | "tool"
  | "permission_request"
  | "permission_resolved"
  | "stop"
  | "instruction_queued"
  | "instruction_delivered"
  | "instruction_expired"
  | "session_end";

export type Ev = { seq: number; ts: string; kind: EvKind; data: Record<string, unknown> };

export type LiveState = "running" | "waiting_permission" | "idle" | "ended";

export type SessionLive = {
  state: LiveState;
  lastSeenAt: string | null;
  lastAssistantMessage: string | null;
  currentTool: string | null;
  title: string | null;
  cwd: string | null;
};

const RING = 500;
const RUNNING_MS = 60_000;

function localIso(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

export class EventStore {
  private rings = new Map<string, Ev[]>();
  private seqs = new Map<string, number>();
  private lives = new Map<string, SessionLive>();
  private titles = new Map<string, string>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const sid = f.slice(0, -6);
      try {
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as Ev;
          this.index(sid, ev);
        }
      } catch {}
    }
  }

  private index(sid: string, ev: Ev): void {
    let ring = this.rings.get(sid);
    if (!ring) {
      ring = [];
      this.rings.set(sid, ring);
    }
    ring.push(ev);
    if (ring.length > RING) ring.splice(0, ring.length - RING);
    this.seqs.set(sid, ev.seq);
    this.applyToLive(sid, ev);
  }

  private applyToLive(sid: string, ev: Ev): void {
    const live =
      this.lives.get(sid) ??
      ({
        state: "idle",
        lastSeenAt: null,
        lastAssistantMessage: null,
        currentTool: null,
        title: null,
        cwd: null,
      } satisfies SessionLive);
    this.lives.set(sid, live);
    live.lastSeenAt = ev.ts;
    switch (ev.kind) {
      case "session_start":
        live.state = "running";
        if (ev.data.cwd) live.cwd = String(ev.data.cwd);
        break;
      case "user_prompt":
        live.state = "running";
        live.currentTool = null;
        break;
      case "tool":
        live.state = "running";
        live.currentTool = String(ev.data.tool_name ?? "");
        break;
      case "permission_request":
        live.state = "waiting_permission";
        break;
      case "permission_resolved":
        live.state = "running";
        break;
      case "stop":
        live.lastAssistantMessage = (ev.data.last_assistant_message as string) ?? null;
        live.currentTool = null;
        live.state = "idle";
        break;
      case "instruction_delivered":
        live.state = "running";
        break;
      case "session_end":
        live.state = "ended";
        live.currentTool = null;
        break;
      default:
        break;
    }
  }

  append(sid: string, kind: EvKind, data: Record<string, unknown>): Ev {
    const ev: Ev = { seq: (this.seqs.get(sid) ?? 0) + 1, ts: localIso(), kind, data: redactData(data) };
    appendFileSync(join(this.dir, `${sid}.jsonl`), JSON.stringify(ev) + "\n");
    this.index(sid, ev);
    return ev;
  }

  list(sid: string, since = 0, limit = 50): { events: Ev[]; nextSince: number } {
    const all = (this.rings.get(sid) ?? []).filter((e) => e.seq > since);
    const events = all.slice(-limit);
    return { events, nextSince: this.seqs.get(sid) ?? since };
  }

  setTitle(sid: string, title: string): void {
    this.titles.set(sid, title);
    const l = this.lives.get(sid);
    if (l) l.title = title;
  }

  live(sid: string): SessionLive {
    const l =
      this.lives.get(sid) ??
      ({
        state: "idle",
        lastSeenAt: null,
        lastAssistantMessage: null,
        currentTool: null,
        title: this.titles.get(sid) ?? null,
        cwd: null,
      } satisfies SessionLive);
    if (l.state === "running" || l.state === "waiting_permission") {
      const age = l.lastSeenAt ? Date.now() - Date.parse(l.lastSeenAt) : Infinity;
      if (age > RUNNING_MS && l.state === "running") return { ...l, state: "idle" };
    }
    return l;
  }

  hasRecentActivity(sid: string, ms: number): boolean {
    const l = this.lives.get(sid);
    if (!l?.lastSeenAt) return false;
    return Date.now() - Date.parse(l.lastSeenAt) < ms;
  }
}
