import { randomBytes } from "node:crypto";

export type PendingKind = "permission" | "elicitation" | "hook_permission";

export type PendingOption = { id: string; label: string; kind: string };

export type PendingAction = {
  handle: string;
  sessionId: string;
  kind: PendingKind;
  createdAt: string;
  title: string;
  options: PendingOption[];
  rawParams?: unknown;
};

type Entry = PendingAction & {
  resolve: (answer: unknown) => void;
};

const entries = new Map<string, Entry>();

function newHandle(): string {
  return `a_${randomBytes(6).toString("hex")}`;
}

// Expose only safe permission choices: reject / allow-once / allow-session.
// Never expose or auto-select an unconditional allow_always option.
function exposedPermissionOptions(raw: Array<{ optionId: string; name: string; kind: string }>): PendingOption[] {
  const out: PendingOption[] = [];
  for (const o of raw) {
    if (o.kind === "reject_once" || o.kind === "reject_always") {
      out.push({ id: o.optionId, label: o.name, kind: o.kind });
    } else if (o.kind === "allow_once") {
      out.push({ id: o.optionId, label: o.name, kind: o.kind });
    } else if (/session/i.test(o.optionId) || /session/i.test(o.name)) {
      out.push({ id: o.optionId, label: o.name, kind: "allow_session" });
    }
  }
  return out;
}

export function addPendingPermission(
  sessionId: string,
  title: string,
  rawOptions: Array<{ optionId: string; name: string; kind: string }>,
): { handle: string; promise: Promise<unknown> } {
  const handle = newHandle();
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  entries.set(handle, {
    handle,
    sessionId,
    kind: "permission",
    createdAt: new Date().toISOString(),
    title,
    options: exposedPermissionOptions(rawOptions),
    resolve,
  });
  return { handle, promise };
}

// Permission raised by a lifecycle hook (not ACP): options are approve/deny only.
export function addPendingHookPermission(
  sessionId: string,
  title: string,
): { handle: string; promise: Promise<unknown> } {
  const handle = newHandle();
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  entries.set(handle, {
    handle,
    sessionId,
    kind: "hook_permission",
    createdAt: new Date().toISOString(),
    title,
    options: [
      { id: "approve", label: "Approve", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "reject_once" },
    ],
    resolve,
  });
  return { handle, promise };
}

export function addPendingElicitation(
  sessionId: string,
  rawParams: unknown,
): { handle: string; promise: Promise<unknown> } {
  const handle = newHandle();
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  const title =
    typeof rawParams === "object" && rawParams !== null
      ? String((rawParams as Record<string, unknown>).message ?? "elicitation")
      : "elicitation";
  entries.set(handle, {
    handle,
    sessionId,
    kind: "elicitation",
    createdAt: new Date().toISOString(),
    title,
    options: [],
    rawParams,
    resolve,
  });
  return { handle, promise };
}

export function listPending(sessionId?: string): PendingAction[] {
  return [...entries.values()]
    .filter((e) => !sessionId || e.sessionId === sessionId)
    .map(({ resolve: _r, ...pub }) => pub);
}

export function respond(handle: string, answer: unknown): boolean {
  const e = entries.get(handle);
  if (!e) return false;
  entries.delete(handle);
  e.resolve(answer);
  return true;
}

export function drop(handle: string): void {
  const e = entries.get(handle);
  if (!e) return;
  entries.delete(handle);
  e.resolve({ outcome: { outcome: "cancelled" } });
}

export function dropForSession(sessionId: string): void {
  for (const [h, e] of entries) {
    if (e.sessionId === sessionId) {
      entries.delete(h);
      e.resolve({ outcome: { outcome: "cancelled" } });
    }
  }
}

export function pendingCount(): number {
  return entries.size;
}
