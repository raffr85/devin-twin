import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function paths(): { dir: string; file: string } {
  const dir =
    process.env.TWIN_STATE_DIR ?? process.env.DLB_STATE_DIR ?? join(homedir(), ".local/share/devin-twin");
  return { dir, file: join(dir, "audit.jsonl") };
}

export function audit(entry: Record<string, unknown>): void {
  try {
    const { dir, file } = paths();
    mkdirSync(dir, { recursive: true });
    const safe: Record<string, unknown> = { ts: new Date().toISOString(), ...entry };
    for (const k of Object.keys(safe)) {
      const v = safe[k];
      if (typeof v === "string" && v.length > 200) safe[k] = v.slice(0, 200) + "…";
    }
    appendFileSync(file, JSON.stringify(safe) + "\n");
  } catch {}
}
