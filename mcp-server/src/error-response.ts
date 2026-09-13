/**
 * OPE-909 item 3 — an error response carries a request id, never the error.
 *
 * Three MCP Worker paths put `err.message` into the response body: the two
 * workflow status endpoints and the top-level OAuthProvider catch. The last is
 * reachable without authentication, so whatever a thrown library error said —
 * a binding name, an internal URL, a stack-derived hint — went to anyone.
 *
 * The detail still exists: it is logged under the same request id the caller
 * receives, so "request_id X failed" is one error_logs lookup away.
 */
import { logError } from "./logger.js";

export interface OpaqueErrorOptions {
  /** error_logs `source`. */
  source: string;
  /** What was being attempted — logged, not returned. */
  message: string;
  /** The thrown value. Logged, never serialized into the response. */
  err: unknown;
  /** Stable machine code the caller may branch on. */
  code: string;
  status: number;
  context?: Record<string, unknown>;
}

/** Cloudflare's ray id when present (it also appears in CF's own logs), else a UUID. */
export function requestIdFor(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

export async function opaqueErrorResponse(
  db: D1Database | null | undefined,
  request: Request,
  opts: OpaqueErrorOptions
): Promise<Response> {
  const requestId = requestIdFor(request);
  // Logging must never turn a handled error into an unhandled one.
  await logError(db, {
    source: opts.source,
    message: `${opts.message} [request_id=${requestId}]`,
    error: opts.err,
    statusCode: opts.status,
    context: { ...(opts.context ?? {}), requestId },
  }).catch(() => {});
  return new Response(JSON.stringify({ error: opts.code, request_id: requestId }), {
    status: opts.status,
    headers: { "Content-Type": "application/json" },
  });
}
