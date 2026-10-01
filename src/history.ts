import type { SessionUpdate } from "@agentclientprotocol/sdk";

export type TranscriptItem = {
  role: "user" | "agent" | "thought" | "tool";
  text: string;
  toolCallId?: string;
  toolTitle?: string;
  status?: string;
};

export type SessionState = "running" | "idle";

function textOf(content: unknown): string {
  if (typeof content === "object" && content !== null) {
    const c = content as Record<string, unknown>;
    if (c.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const o = c as Record<string, unknown>;
      if (o.type === "content") return textOf(o.content);
      if (o.type === "diff") return `[diff] ${String(o.path ?? "")}`;
      if (o.type === "terminal") return `[terminal ${String(o.terminalId ?? "")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function foldUpdates(updates: SessionUpdate[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndex = new Map<string, number>();
  for (const u of updates) {
    const kind = (u as { sessionUpdate: string }).sessionUpdate;
    switch (kind) {
      case "user_message_chunk":
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const role =
          kind === "user_message_chunk" ? "user" : kind === "agent_message_chunk" ? "agent" : "thought";
        const text = textOf((u as { content?: unknown }).content);
        if (!text) break;
        const last = items[items.length - 1];
        if (last && last.role === role) last.text += text;
        else items.push({ role, text });
        break;
      }
      case "tool_call": {
        const t = u as unknown as {
          toolCallId: string;
          title?: string;
          status?: string;
          rawInput?: unknown;
          content?: unknown;
        };
        const text = toolContentText(t.content) || JSON.stringify(t.rawInput ?? "");
        toolIndex.set(t.toolCallId, items.length);
        items.push({
          role: "tool",
          text,
          toolCallId: t.toolCallId,
          toolTitle: t.title,
          status: t.status,
        });
        break;
      }
      case "tool_call_update": {
        const t = u as unknown as { toolCallId: string; status?: string; content?: unknown };
        const idx = toolIndex.get(t.toolCallId);
        const item = idx === undefined ? undefined : items[idx];
        if (!item) break;
        if (t.status) item.status = t.status;
        const extra = toolContentText(t.content);
        if (extra) item.text = item.text ? `${item.text}\n${extra}` : extra;
        break;
      }
      default:
        break;
    }
  }
  return items;
}

export function summarize(
  transcript: TranscriptItem[],
  opts: { maxItems?: number; maxChars?: number } = {},
): TranscriptItem[] {
  const maxItems = opts.maxItems ?? 30;
  const maxChars = opts.maxChars ?? 8000;
  const tail = transcript.slice(-maxItems);
  const out: TranscriptItem[] = [];
  let budget = maxChars;
  for (let i = tail.length - 1; i >= 0; i--) {
    const it = tail[i];
    if (!it) break;
    const text = it.text.length > budget ? it.text.slice(0, budget) + "…" : it.text;
    out.unshift({ ...it, role: it.role, text });
    budget -= it.text.length;
    if (budget <= 0) break;
  }
  return out;
}

const RECENT_MS = 5 * 60 * 1000;

export function deriveState(
  transcript: TranscriptItem[],
  opts: { isLocked: boolean; updatedAt?: string },
): { state: SessionState; lastActivity: string | null } {
  const last = transcript[transcript.length - 1];
  let running = false;
  if (last?.role === "tool" && last.status !== "completed" && last.status !== "failed") {
    running = true;
  }
  const updatedAt = opts.updatedAt ? Date.parse(opts.updatedAt) : NaN;
  const recent = Number.isFinite(updatedAt) && Date.now() - updatedAt < RECENT_MS;
  if (opts.isLocked && recent) running = true;
  return {
    state: running ? "running" : "idle",
    lastActivity: opts.updatedAt ?? null,
  };
}
