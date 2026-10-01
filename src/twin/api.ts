import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://api.devin.ai";

export function devinApiKey(): string | null {
  if (process.env.DEVIN_API_KEY) return process.env.DEVIN_API_KEY;
  try {
    const text = readFileSync(join(homedir(), ".local/share/devin/credentials.toml"), "utf8");
    return text.match(/windsurf_api_key\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function devinOrgId(): string | null {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), ".config/devin/config.json"), "utf8"),
    ) as Record<string, unknown>;
    const devin = cfg.devin as Record<string, unknown> | undefined;
    return (devin?.org_id as string) ?? null;
  } catch {
    return null;
  }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class DevinApi {
  constructor(
    private key: string,
    private org: string,
    private fetcher: Fetcher = fetch,
  ) {}

  private req(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetcher(`${BASE}/v3/organizations/${this.org}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async createSession(body: Record<string, unknown>): Promise<{ session_id: string; url: string }> {
    const r = await this.req("POST", "/sessions", body);
    if (!r.ok) throw new Error(`create session: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<{ session_id: string; url: string }>;
  }

  async postMessage(devinId: string, message: string): Promise<void> {
    const id = devinId.startsWith("devin-") ? devinId : `devin-${devinId}`;
    const r = await this.req("POST", `/sessions/${id}/messages`, { message });
    if (!r.ok) throw new Error(`post message: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  async getSession(devinId: string): Promise<unknown> {
    const id = devinId.startsWith("devin-") ? devinId : `devin-${devinId}`;
    const r = await this.req("GET", `/sessions/${id}`);
    if (!r.ok) throw new Error(`get session: HTTP ${r.status}`);
    return r.json();
  }

  async createPlaybook(title: string, body: string): Promise<{ playbook_id: string }> {
    const r = await this.req("POST", "/playbooks", { title, body });
    if (!r.ok) throw new Error(`create playbook: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<{ playbook_id: string }>;
  }

  async getPlaybook(id: string): Promise<{ playbook_id: string; body: string } | null> {
    const r = await this.req("GET", `/playbooks/${id}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`get playbook: HTTP ${r.status}`);
    return r.json() as Promise<{ playbook_id: string; body: string }>;
  }

  async updatePlaybook(id: string, title: string, body: string): Promise<void> {
    const r = await this.req("PUT", `/playbooks/${id}`, { title, body });
    if (!r.ok) throw new Error(`update playbook: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  async archive(devinId: string): Promise<void> {
    const id = devinId.startsWith("devin-") ? devinId : `devin-${devinId}`;
    const r = await this.req("POST", `/sessions/${id}/archive`);
    if (!r.ok) throw new Error(`archive: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}
