import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Item = { text: string; ts: number };

export class InstructionQueue {
  private queues = new Map<string, Item[]>();

  constructor(private file: string) {
    try {
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<
          string,
          Array<Item | string>
        >;
        for (const [k, v] of Object.entries(data)) {
          if (!Array.isArray(v)) continue;
          this.queues.set(
            k,
            v.map((i) => (typeof i === "string" ? { text: i, ts: 0 } : i)),
          );
        }
      }
    } catch {}
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.queues)));
  }

  enqueue(sessionId: string, text: string): void {
    const q = this.queues.get(sessionId) ?? [];
    q.push({ text, ts: Date.now() });
    this.queues.set(sessionId, q);
    this.persist();
  }

  /** Pop all items; entries older than ttlMs are returned in `expired`. */
  popAll(sessionId: string, ttlMs = Infinity): { items: string[]; expired: string[] } {
    const q = this.queues.get(sessionId) ?? [];
    const items: string[] = [];
    const expired: string[] = [];
    const cutoff = Date.now() - ttlMs;
    for (const i of q) (i.ts >= cutoff ? items : expired).push(i.text);
    if (q.length) {
      this.queues.delete(sessionId);
      this.persist();
    }
    return { items, expired };
  }

  size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  total(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
