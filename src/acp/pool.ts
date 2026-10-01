import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import { AcpProcess, isSessionLockedError, type SessionInfo } from "./process.ts";
import { audit } from "../audit.ts";
import {
  addPendingElicitation,
  addPendingPermission,
  dropForSession,
} from "../pending.ts";

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.then(
      () => {},
      () => {},
    );
    return p;
  }
}

class Semaphore {
  private count = 0;
  private waiters: Array<() => void> = [];
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.count--;
  }
}

type Owner = {
  proc: AcpProcess;
  updates: SessionUpdate[];
  startedAt: number;
  ttlTimer?: ReturnType<typeof setTimeout>;
};

export class AcpPool {
  private reader: AcpProcess | null = null;
  private readerMutex = new Mutex();
  private mutationMutex = new Mutex();
  private loadSem = new Semaphore(2);
  private owners = new Map<string, Owner>();

  constructor(private cfg: Config) {}

  private async getReader(): Promise<AcpProcess> {
    return this.readerMutex.run(async () => {
      if (this.reader?.alive) return this.reader;
      this.reader?.kill();
      this.reader = await AcpProcess.spawn(this.cfg, this.cfg.workspaces[0] ?? "/");
      return this.reader;
    });
  }

  readerAlive(): boolean {
    return this.reader?.alive ?? false;
  }

  ownedSessionIds(): Set<string> {
    return new Set(this.owners.keys());
  }

  isOwned(sessionId: string): boolean {
    return this.owners.has(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    const reader = await this.getReader();
    try {
      return await reader.listSessions();
    } catch (e) {
      if (!reader.alive) {
        this.reader = null;
        const r2 = await this.getReader();
        return r2.listSessions();
      }
      throw e;
    }
  }

  async loadTranscript(
    sessionId: string,
    cwd: string,
  ): Promise<{ updates: SessionUpdate[]; lockedByOther: boolean }> {
    await this.loadSem.acquire();
    let proc: AcpProcess | null = null;
    try {
      const updates: SessionUpdate[] = [];
      proc = await AcpProcess.spawn(this.cfg, cwd, {
        onUpdate: (_id, u) => updates.push(u),
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      });
      // A locked session replays its full history, THEN fails with
      // session_locked — keep the updates and report read-only.
      try {
        await proc.loadSession(sessionId, cwd);
        return { updates, lockedByOther: false };
      } catch (e) {
        if (isSessionLockedError(e)) return { updates, lockedByOther: true };
        throw e;
      }
    } finally {
      proc?.kill();
      this.loadSem.release();
    }
  }

  async sendMessage(
    sessionId: string,
    cwd: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.owners.has(sessionId)) {
      return { ok: false, reason: "turn_already_running" };
    }
    return this.mutationMutex.run(async () => {
      if (this.owners.has(sessionId)) {
        return { ok: false, reason: "turn_already_running" };
      }
      const owner: Owner = { proc: null as unknown as AcpProcess, updates: [], startedAt: Date.now() };
      this.owners.set(sessionId, owner);
      try {
        const proc = await AcpProcess.spawn(this.cfg, cwd, {
          onUpdate: (id, u) => {
            if (id === sessionId) owner.updates.push(u);
          },
          onPermission: (params) => {
            const { handle, promise } = addPendingPermission(
              sessionId,
              params.toolCall?.title ?? "permission",
              (params.options ?? []).map((o) => ({
                optionId: o.optionId,
                name: o.name,
                kind: o.kind,
              })),
            );
            void handle;
            return promise.then((answer) => answer as never);
          },
          onElicitation: (params) => {
            const { promise } = addPendingElicitation(sessionId, params);
            return promise.then((a) => a as never);
          },
        });
        owner.proc = proc;
        try {
          await proc.loadSession(sessionId, cwd);
        } catch (e) {
          if (isSessionLockedError(e)) {
            this.releaseOwner(sessionId);
            return { ok: false, reason: "locked_by_other_client" };
          }
          throw e;
        }
        owner.ttlTimer = setTimeout(() => this.expireOwner(sessionId), this.cfg.turnTtlMs);
        proc
          .prompt(sessionId, text)
          .catch(() => {})
          .finally(() => this.releaseOwner(sessionId));
        return { ok: true };
      } catch (e) {
        this.releaseOwner(sessionId);
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  private releaseOwner(sessionId: string): void {
    const owner = this.owners.get(sessionId);
    if (!owner) return;
    if (owner.ttlTimer) clearTimeout(owner.ttlTimer);
    this.owners.delete(sessionId);
    dropForSession(sessionId);
    owner.proc?.kill();
  }

  private expireOwner(sessionId: string): void {
    const owner = this.owners.get(sessionId);
    if (!owner) return;
    audit({ event: "turn_timeout", session: `s_${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}` });
    void (async () => {
      await Promise.race([
        owner.proc.cancel(sessionId).catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
      // grace so the agent can read the cancel notification before SIGKILL
      await Bun.sleep(500);
      this.releaseOwner(sessionId);
    })();
  }

  ownerUpdates(sessionId: string): SessionUpdate[] {
    return this.owners.get(sessionId)?.updates ?? [];
  }

  shutdown(): void {
    this.reader?.kill();
    for (const [id] of this.owners) this.releaseOwner(id);
  }
}
