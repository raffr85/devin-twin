import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { redactSecrets } from "./redact.ts";

export function attachRoot(): string {
  const dir =
    process.env.TWIN_STATE_DIR ??
    process.env.DLB_STATE_DIR ??
    join(homedir(), ".local/share/devin-twin");
  return join(dir, "attach");
}

export function attachDirFor(sid: string): string {
  const dir = join(attachRoot(), sid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
};
const TEXT_MIMES = new Set(["text/plain", "text/markdown"]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_SCAN = 4;

export type Artifact = { path: string; name: string; mime: string; bytes: Uint8Array };

type AttachState = Record<string, { lastSeen: number; uploaded: Record<string, number> }>;

export class ArtifactWatcher {
  private stateFile: string;
  private state: AttachState = {};

  constructor(
    private root = attachRoot(),
    private settleMs = 1500,
  ) {
    this.stateFile = join(root, "state.json");
    try {
      if (existsSync(this.stateFile))
        this.state = JSON.parse(readFileSync(this.stateFile, "utf8")) as AttachState;
    } catch {}
  }

  private persist(): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(this.state));
  }

  dirFor(sid: string): string {
    const dir = join(this.root, sid);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Collect new, un-uploaded artifacts for a session (max 4 per call). */
  async collect(sid: string): Promise<Artifact[]> {
    const dir = join(this.root, sid);
    if (!existsSync(dir)) return [];
    const rec = (this.state[sid] ??= { lastSeen: 0, uploaded: {} });
    const realDir = realpathSync(dir);
    const out: Artifact[] = [];
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    let maxMtime = rec.lastSeen;
    for (const name of entries.sort()) {
      if (out.length >= MAX_PER_SCAN) break;
      if (name === "state.json") continue;
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const mtime = st.mtimeMs;
      if (mtime > maxMtime) maxMtime = mtime;
      if (Date.now() - mtime < this.settleMs) continue; // still being written
      const mime = MIME[extname(name).toLowerCase()];
      if (!mime) continue;
      if (st.size === 0 || st.size > MAX_BYTES) continue;
      if (rec.uploaded[name] === mtime) continue;
      try {
        if (!resolve(realpathSync(path)).startsWith(resolve(realDir) + "/")) continue;
      } catch {
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(path));
      } catch {
        continue;
      }
      if (TEXT_MIMES.has(mime))
        bytes = new TextEncoder().encode(redactSecrets(Buffer.from(bytes).toString("utf8")));
      out.push({ path, name, mime, bytes });
    }
    rec.lastSeen = maxMtime;
    this.persist();
    return out;
  }

  /** Mark artifacts as uploaded so they are never sent again. */
  markUploaded(sid: string, arts: Artifact[]): void {
    const rec = (this.state[sid] ??= { lastSeen: 0, uploaded: {} });
    for (const a of arts) {
      try {
        rec.uploaded[a.name] = lstatSync(a.path).mtimeMs;
      } catch {
        rec.uploaded[a.name] = Date.now();
      }
    }
    this.persist();
  }
}
