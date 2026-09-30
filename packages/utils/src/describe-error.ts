/**
 * OPE-1030 — the error text written to `error_logs`, WITH its cause chain.
 *
 * Drizzle wraps a failed statement in `DrizzleQueryError`, whose message is
 * `Failed query: <sql>\nparams: <params>` and whose driver error — the
 * `D1_ERROR: …` / `SQLITE_*` string that says what actually went wrong — lives
 * only on `.cause`. Every `error_logs` writer recorded `error.message`, so from
 * 2026-09-11 to 09-15, 227 of 229 `Failed query:` rows held the SQL and the
 * params and not the failure; a 225-row burst on public `/blog` could not be
 * diagnosed at all.
 *
 * One helper for all three writers (main-app `logError`, the server-render
 * capture, and the MCP Worker's `logError`), because a fix wired into one
 * writer would leave the other two blind.
 */

const MAX_CAUSE_DEPTH = 5;

function messageOf(value: unknown): string | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { message?: unknown }).message === "string"
  ) {
    const m = (value as { message: string }).message;
    return m.length > 0 ? m : null;
  }
  return null;
}

/** Messages of `err.cause`, `err.cause.cause`, … — depth-limited and cycle-safe. */
export function errorCauseMessages(err: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>([err]);
  let cur: unknown =
    err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
  for (let depth = 0; cur !== undefined && cur !== null && depth < MAX_CAUSE_DEPTH; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const m = messageOf(cur) ?? (typeof cur === "string" ? cur : null);
    if (m) out.push(m);
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return out;
}

/**
 * `err.message` followed by `\ncause: <message>` for each cause not already
 * contained in it. With `maxChars`, the WRAPPER text is truncated and the causes
 * are kept whole — the cause is the part a reader needs, and a Drizzle wrapper
 * carrying a long params list is exactly the message that gets cut.
 */
export function describeError(err: unknown, maxChars?: number): string {
  const base = messageOf(err) ?? String(err);
  const causes = errorCauseMessages(err).filter((c) => !base.includes(c));
  const tail = causes.map((c) => `\ncause: ${c}`).join("");
  if (maxChars === undefined || base.length + tail.length <= maxChars) return base + tail;
  const room = Math.max(0, maxChars - tail.length - 1);
  return base.slice(0, room) + "…" + tail;
}
