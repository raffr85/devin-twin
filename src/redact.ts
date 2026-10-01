const MASK = "«redacted»";

const PATTERNS: Array<[RegExp, string | ((...args: string[]) => string)]> = [
  // key=value / key: value shapes keep the key name (Authorization may carry "Bearer x")
  [/(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)((?:Bearer\s+)?\S+)/gi, (...a: string[]) => `${a[1]}${a[2]}${MASK}`],
  [/\bBearer\s+\S+/gi, `Bearer ${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, MASK],
  [/\bghp_[A-Za-z0-9]{8,}\b/g, MASK],
  [/\bcog_[A-Za-z0-9_-]{8,}\b/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\b[0-9a-fA-F]{32,}\b/g, MASK],
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, rep as string);
  }
  return out;
}

export function redactData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}
