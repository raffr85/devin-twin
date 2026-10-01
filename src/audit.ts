import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.DLB_STATE_DIR ?? join(homedir(), ".local/share/devin-local-bridge");
const FILE = join(DIR, "audit.jsonl");

export function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(DIR, { recursive: true });
    const safe: Record<string, unknown> = { ts: new Date().toISOString(), ...entry };
    for (const k of Object.keys(safe)) {
      const v = safe[k];
      if (typeof v === "string" && v.length > 200) safe[k] = v.slice(0, 200) + "…";
    }
    appendFileSync(FILE, JSON.stringify(safe) + "\n");
  } catch {}
}
