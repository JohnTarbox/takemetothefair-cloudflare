/**
 * OPE-1620 — request signing for the promoter API. Pure: every database touch
 * is injected (`AuthDeps`), so the whole decision is unit-tested.
 *
 * A request carries four headers:
 *   X-MMATF-Key:        <key_id>            (public, `mmk_…`)
 *   X-MMATF-Timestamp:  <unix seconds>
 *   X-MMATF-Request-Id: <unique string, ≤ 100 printable ASCII>
 *   X-MMATF-Signature:  sha256=<hex>
 * and the signature is hex(HMAC-SHA256(secret, "<timestamp>.<request_id>.<raw body>")),
 * the house HMAC (mcp-server/src/syndication/dispatch.ts) with a timestamp and a
 * request id bound in so a captured request cannot be replayed.
 *
 * Order of checks — each fails closed:
 *   1. headers present and well-formed                         → 401
 *   2. key known and not revoked                                → 401
 *   3. timestamp within ±300 s of now                           → 401
 *   4. signature matches, compared in constant time             → 401
 *   5. rate limit for this key (optional dep)                   → 429
 *   6. request id never seen for this key (recorded atomically) → 409
 * The request id is recorded only AFTER the signature verifies, so nobody
 * without the secret can burn a promoter's ids, and only after the rate limit,
 * so a 429'd request may be retried with the same id.
 *
 * Nothing here logs. Callers must never log the secret or the signature.
 */

export const HEADER_KEY = "x-mmatf-key";
export const HEADER_TIMESTAMP = "x-mmatf-timestamp";
export const HEADER_REQUEST_ID = "x-mmatf-request-id";
export const HEADER_SIGNATURE = "x-mmatf-signature";

/** How far a request's timestamp may be from the server clock, either way. */
export const MAX_SKEW_SECONDS = 300;
export const MAX_REQUEST_ID_LENGTH = 100;
/** Requests per key per window, counted on the BurstCounter Durable Object (handler.ts). */
export const PROMOTER_API_RATE = { max: 60, periodSeconds: 60 } as const;

export type AuthErrorCode =
  | "missing_auth_headers"
  | "invalid_key"
  | "stale_timestamp"
  | "bad_signature"
  | "rate_limited"
  | "replayed_request";

export interface ApiKeyRecord {
  keyId: string;
  secret: string;
  promoterId: string;
  /** The promoter's own user account (citations' created_by), if any. */
  promoterUserId: string | null;
  revokedAt: Date | null;
}

export interface AuthDeps {
  lookupKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** True if newly recorded; false if this (key, request id) was seen before. */
  consumeRequestId(keyId: string, requestId: string): Promise<boolean>;
  /** Optional per-key limiter. */
  rateLimit?(
    keyId: string
  ): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
}

export type AuthResult =
  | { ok: true; key: ApiKeyRecord; requestId: string; timestamp: number }
  | {
      ok: false;
      status: 401 | 409 | 429;
      code: AuthErrorCode;
      message: string;
      retryAfterSeconds?: number;
      /** The claimed key id, for logging (never the secret or the signature). */
      keyId?: string;
    };

const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact string that is signed. */
export const signingString = (timestamp: string, requestId: string, body: string) =>
  `${timestamp}.${requestId}.${body}`;

/** Sign a request the way a client must (used by the docs' examples and the tests). */
export async function signRequest(
  secret: string,
  timestamp: string,
  requestId: string,
  body: string
): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, signingString(timestamp, requestId, body))}`;
}

/**
 * Constant-time string comparison: the time taken depends only on the length
 * of `expected`, never on where the first difference is.
 */
export function timingSafeEqual(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

const fail = (
  status: 401 | 409 | 429,
  code: AuthErrorCode,
  message: string,
  extra: { keyId?: string; retryAfterSeconds?: number } = {}
): AuthResult => ({ ok: false, status, code, message, ...extra });

export async function authenticate(
  headers: Headers,
  body: string,
  nowSeconds: number,
  deps: AuthDeps
): Promise<AuthResult> {
  const keyId = headers.get(HEADER_KEY)?.trim() ?? "";
  const ts = headers.get(HEADER_TIMESTAMP)?.trim() ?? "";
  const requestId = headers.get(HEADER_REQUEST_ID)?.trim() ?? "";
  const signature = headers.get(HEADER_SIGNATURE)?.trim() ?? "";

  if (!keyId || !ts || !requestId || !signature)
    return fail(
      401,
      "missing_auth_headers",
      "Send X-MMATF-Key, X-MMATF-Timestamp, X-MMATF-Request-Id and X-MMATF-Signature."
    );
  if (!/^mmk_[0-9a-f]{8,64}$/.test(keyId))
    return fail(401, "invalid_key", "Unknown or revoked API key.");
  if (requestId.length > MAX_REQUEST_ID_LENGTH || !/^[\x21-\x7e]+$/.test(requestId))
    return fail(
      401,
      "missing_auth_headers",
      `X-MMATF-Request-Id must be 1-${MAX_REQUEST_ID_LENGTH} printable characters, no spaces.`,
      { keyId }
    );

  const key = await deps.lookupKey(keyId);
  if (!key || key.revokedAt)
    return fail(401, "invalid_key", "Unknown or revoked API key.", { keyId });

  if (!/^\d{1,12}$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > MAX_SKEW_SECONDS)
    return fail(
      401,
      "stale_timestamp",
      `X-MMATF-Timestamp must be the current Unix time in seconds (within ${MAX_SKEW_SECONDS} s).`,
      { keyId }
    );

  const expected = `sha256=${await hmacSha256Hex(key.secret, signingString(ts, requestId, body))}`;
  if (!timingSafeEqual(signature.toLowerCase(), expected))
    return fail(401, "bad_signature", "The signature does not match this request.", { keyId });

  if (deps.rateLimit) {
    const rl = await deps.rateLimit(keyId);
    if (!rl.allowed)
      return fail(429, "rate_limited", "Too many requests for this key. Slow down and retry.", {
        keyId,
        retryAfterSeconds: rl.retryAfterSeconds,
      });
  }

  if (!(await deps.consumeRequestId(keyId, requestId)))
    return fail(
      409,
      "replayed_request",
      "This X-MMATF-Request-Id was already used with this key. Send a new one per request.",
      { keyId }
    );

  return { ok: true, key, requestId, timestamp: Number(ts) };
}
