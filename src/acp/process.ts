import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import type { Subprocess } from "bun";
import type { Config } from "../config.ts";

export function isSessionLockedError(e: unknown): boolean {
  if (!(e instanceof RequestError)) return false;
  if (e.code === -32015) return true;
  const data = e.data as Record<string, unknown> | undefined;
  return data?.["cognition.ai/errorKind"] === "session_locked";
}

export type SessionInfo = {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt?: string;
  isLocked: boolean;
};

export type UpdateHandler = (sessionId: string, update: SessionUpdate) => void;
export type PermissionHandler = (
  params: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;
export type ElicitationHandler = (
  params: CreateElicitationRequest,
) => Promise<CreateElicitationResponse>;

export type AcpHooks = {
  onUpdate?: UpdateHandler;
  onPermission?: PermissionHandler;
  onElicitation?: ElicitationHandler;
};

export class AcpProcess {
  private constructor(
    private proc: Subprocess,
    public readonly conn: ClientSideConnection,
  ) {}

  static async spawn(cfg: Config, cwd: string, hooks: AcpHooks = {}): Promise<AcpProcess> {
    const proc = Bun.spawn([cfg.devinBin, ...cfg.devinArgs, "acp"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DEVIN_MODEL: undefined as unknown as string },
    });
    void new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => {});
    const stdin = new WritableStream<Uint8Array>({
      async write(chunk) {
        proc.stdin.write(chunk);
        await proc.stdin.flush();
      },
      close() {
        proc.stdin.end();
      },
    });
    const stream = ndJsonStream(stdin, proc.stdout as ReadableStream<Uint8Array>);
    const client: Client = {
      sessionUpdate: (params: SessionNotification) => {
        hooks.onUpdate?.(params.sessionId, params.update);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        if (!hooks.onPermission) return { outcome: { outcome: "cancelled" } };
        return hooks.onPermission(params);
      },
      createElicitation: async (params: CreateElicitationRequest) => {
        if (!hooks.onElicitation) {
          return { action: "decline" } as CreateElicitationResponse;
        }
        return hooks.onElicitation(params);
      },
      extMethod: async () => ({}),
      extNotification: () => {},
    };
    const conn = new ClientSideConnection(() => client, stream);
    const self = new AcpProcess(proc, conn);
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "devin-local-bridge", version: "0.1.0" },
    });
    await conn.authenticate({
      methodId: "devin-browser",
      _meta: { api_key: cfg.apiKey ?? "" },
    });
    return self;
  }

  get alive(): boolean {
    return this.proc.exitCode === null;
  }

  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    const res = await this.conn.listSessions(cwd ? { cwd } : {});
    return (res.sessions ?? []).map((s) => {
      const meta = (s._meta ?? {}) as Record<string, unknown>;
      return {
        sessionId: s.sessionId,
        cwd: s.cwd ?? "",
        title: s.title ?? "",
        updatedAt: s.updatedAt ?? (meta["cognition.ai/createdAt"] as string | undefined),
        isLocked: Boolean(meta["cognition.ai/isLocked"]),
      };
    });
  }

  async newSession(cwd: string): Promise<string> {
    const res = await this.conn.newSession({ cwd, mcpServers: [] });
    return (res as { sessionId: string }).sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.conn.loadSession({ sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason?: string }> {
    const res = await this.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return { stopReason: (res as { stopReason?: string }).stopReason };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.conn.cancel({ sessionId });
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {}
  }
}
