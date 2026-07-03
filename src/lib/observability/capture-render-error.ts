/**
 * OPE-80 — server-side render-error capture core.
 *
 * The OPE-25 client pipeline persists what the browser sees, but React redacts
 * a server render error to an opaque `digest` before it reaches the client, so
 * the user-reported row never carries the REAL message or stack. This module is
 * the testable core wired to Next's stable `onRequestError` hook
 * (src/instrumentation.ts): it writes ONE `error_logs` row with the true
 * message + stack + digest, plus the queryable `route` column — so a client row
 * (source='client') and the server row (source='server-render') for the same
 * failure are JOINABLE on `digest` and both filterable by `route`.
 *
 * Invariants:
 *   - DEFENSIVE: the whole body is wrapped so a logging failure NEVER throws —
 *     a broken log write must not compound the render failure that triggered it.
 *   - SECURITY: only message / stack / digest / route / method are persisted.
 *     NEVER request bodies, cookies, query strings, or auth headers.
 */
import { errorLogs } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/** Truncation caps — keep a single row bounded even for pathological errors. */
const MAX_MESSAGE_CHARS = 4_000;
const MAX_STACK_CHARS = 8_000;
const MAX_DIGEST_CHARS = 256;

export interface CaptureServerRenderErrorArgs {
  /** The thrown value from `onRequestError` — usually an Error, but not guaranteed. */
  error: unknown;
  /** The Next `onRequestError` request descriptor (path + method only are read). */
  request?: { path?: string; method?: string };
  /** The Next `onRequestError` context descriptor. */
  context?: { routePath?: string; routerKind?: string; routeType?: string };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

/**
 * Persist one `error_logs` row describing a server render/route error. Never
 * throws: on any failure it falls back to `console.error` only.
 *
 * `db` is nullable so a missing binding (off-CF / partial context) is a no-op
 * rather than a crash.
 */
export async function captureServerRenderError(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  args: CaptureServerRenderErrorArgs
): Promise<void> {
  try {
    const { error, request, context } = args;

    const err = error as
      | { message?: unknown; stack?: unknown; digest?: unknown }
      | null
      | undefined;

    const rawMessage =
      err && typeof err.message === "string" && err.message.length > 0
        ? err.message
        : String(error);
    const message = truncate(rawMessage, MAX_MESSAGE_CHARS);

    const stackTrace =
      err && typeof err.stack === "string" && err.stack.length > 0
        ? truncate(err.stack, MAX_STACK_CHARS)
        : null;

    const digest =
      err && typeof err.digest === "string" && err.digest.length > 0
        ? truncate(err.digest, MAX_DIGEST_CHARS)
        : null;

    const route = request?.path ?? context?.routePath ?? null;
    const method = request?.method ?? null;

    // Always surface to `wrangler tail` regardless of whether the D1 write lands.
    console.error(
      `[server-render] ${message}${route ? ` (route=${route})` : ""}${digest ? ` digest=${digest}` : ""}`
    );

    if (!db) return;

    await db.insert(errorLogs).values({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      level: "error",
      source: "server-render",
      message,
      stackTrace,
      digest,
      route,
      method,
      // Mirror route into `url` so existing url-based error queries also find it.
      url: route,
      // SECURITY: context holds only routing metadata — no bodies/cookies/headers.
      context: JSON.stringify({
        routerKind: context?.routerKind ?? null,
        routeType: context?.routeType ?? null,
        routePath: context?.routePath ?? null,
      }),
    });
  } catch (captureErr) {
    // A logging failure must never compound the render failure that caused it.
    console.error("[captureServerRenderError] failed to persist render error:", captureErr);
  }
}
