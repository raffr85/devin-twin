// Loaded first by every test file: point the bridge's state dir at a throwaway
// tmpdir BEFORE any src module reads DLB_STATE_DIR (import-time constants).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DLB_STATE_DIR)
  process.env.DLB_STATE_DIR = mkdtempSync(join(tmpdir(), "dlb-testenv-"));
