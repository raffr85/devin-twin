import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class InstructionQueue {
  private queues = new Map<string, string[]>();

  constructor(private file: string) {
    try {
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]>;
        for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) this.queues.set(k, v);
      }
    } catch {}
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.queues)));
  }

  enqueue(sessionId: string, text: string): void {
    const q = this.queues.get(sessionId) ?? [];
    q.push(text);
    this.queues.set(sessionId, q);
    this.persist();
  }

  popAll(sessionId: string): string[] {
    const q = this.queues.get(sessionId) ?? [];
    if (q.length) {
      this.queues.delete(sessionId);
      this.persist();
    }
    return q;
  }

  size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }
}
