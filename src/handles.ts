import { createHash } from "node:crypto";

export class HandleMap {
  private sessionToHandle = new Map<string, string>();
  private handleToSession = new Map<string, string>();
  private workspaceHandles = new Map<string, string>();
  private workspaceByHandle = new Map<string, string>();

  sessionHandle(sessionId: string): string {
    let h = this.sessionToHandle.get(sessionId);
    if (!h) {
      const hex = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
      h = `s_${hex}`;
      this.sessionToHandle.set(sessionId, h);
      this.handleToSession.set(h, sessionId);
    }
    return h;
  }

  sessionIdFor(handle: string): string | null {
    return this.handleToSession.get(handle) ?? null;
  }

  workspaceHandle(absPath: string): string {
    let h = this.workspaceHandles.get(absPath);
    if (!h) {
      const hex = createHash("sha256").update(absPath).digest("hex").slice(0, 8);
      h = `w_${hex}`;
      this.workspaceHandles.set(absPath, h);
      this.workspaceByHandle.set(h, absPath);
    }
    return h;
  }

  workspaceForHandle(handle: string): string | null {
    return this.workspaceByHandle.get(handle) ?? null;
  }
}
