/**
 * K17 (2026-06-07): one-shot upload-slot tokens for the
 * `request_image_upload_slot` MCP tool + `/api/admin/upload-image-direct/[token]`
 * endpoint. Lets an MCP caller obtain a short-lived URL it can POST raw image
 * bytes to, without first having to base64-encode them into a tool argument.
 *
 * Why KV (not D1)
 * ---------------
 * The feedback-tokens pattern (src/lib/feedback-tokens.ts) writes one row
 * per token into D1 with explicit expiry + used_at sweeps. That's the right
 * shape for long-lived (60-day) tokens that need post-hoc analytics.
 *
 * Upload slots have the inverse profile: ≤ 5 min TTL, fire-and-forget, no
 * accounting needed. KV's native `expirationTtl` does the eviction without
 * a sweep job and without growing the D1 schema. The KV namespace
 * `RATE_LIMIT_KV` is already bound to the main app — no infra change.
 *
 * Threat model
 * ------------
 * - Slot issuance requires admin auth on /api/admin/upload-image-slot
 *   (or X-Internal-Key from the MCP Worker).
 * - The 5-minute TTL bounds replay even if the URL leaks.
 * - consumeUploadSlot deletes the KV key before returning claims, so
 *   the same URL can be POSTed only once.
 * - The token is the slot's authorization — keep it out of server logs
 *   (use header transport rather than ?query=) and don't reflect it in
 *   error messages.
 */

const SLOT_TTL_SECONDS = 5 * 60;
const KV_PREFIX = "upload-slot:";
const TOKEN_BYTES = 24;
const MAX_BYTES_DEFAULT = 10 * 1024 * 1024;

export type UploadTargetType = "event" | "vendor" | "venue";

export interface UploadSlotClaims {
  targetType: UploadTargetType;
  targetId: string;
  maxBytes: number;
  issuedAt: number;
  issuedBy: string;
  caption: string | null;
}

export interface IssueUploadSlotArgs {
  targetType: UploadTargetType;
  targetId: string;
  issuedBy: string;
  caption?: string | null;
  maxBytes?: number;
}

export interface IssuedSlot {
  token: string;
  expiresAt: Date;
  maxBytes: number;
}

/**
 * Generate a fresh random token, store the slot's claims in KV with a
 * native TTL, and return the token + expiry + cap so the caller can
 * surface them to the client.
 */
export async function issueUploadSlot(
  kv: KVNamespace,
  args: IssueUploadSlotArgs
): Promise<IssuedSlot> {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = base64UrlEncode(raw);

  const maxBytes = args.maxBytes ?? MAX_BYTES_DEFAULT;
  const issuedAt = Date.now();

  const claims: UploadSlotClaims = {
    targetType: args.targetType,
    targetId: args.targetId,
    maxBytes,
    issuedAt,
    issuedBy: args.issuedBy,
    caption: args.caption ?? null,
  };

  await kv.put(KV_PREFIX + token, JSON.stringify(claims), {
    expirationTtl: SLOT_TTL_SECONDS,
  });

  return {
    token,
    expiresAt: new Date(issuedAt + SLOT_TTL_SECONDS * 1000),
    maxBytes,
  };
}

/**
 * Look up the slot, delete it (one-shot), and return its claims. Returns
 * null if the token is unknown, expired, or the JSON is corrupt — in all
 * cases the caller should respond 401/404 without echoing the token.
 *
 * Concurrent consumes race-resolve via KV's atomic delete: both reads see
 * the value, both deletes succeed, but downstream R2 puts use independent
 * keys (per-call Date.now()) so there's no clobber risk inside the
 * pipeline itself. If we ever need strict "only one upload per slot,"
 * promote to a D1 `used_at` row with `WHERE used_at IS NULL` semantics.
 */
export async function consumeUploadSlot(
  kv: KVNamespace,
  token: string
): Promise<UploadSlotClaims | null> {
  if (!token || token.length < 16 || token.length > 256) return null;

  const raw = await kv.get(KV_PREFIX + token, "text");
  if (!raw) return null;

  await kv.delete(KV_PREFIX + token);

  try {
    const parsed = JSON.parse(raw) as Partial<UploadSlotClaims>;
    if (
      typeof parsed.targetType !== "string" ||
      !["event", "vendor", "venue"].includes(parsed.targetType) ||
      typeof parsed.targetId !== "string" ||
      typeof parsed.maxBytes !== "number" ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.issuedBy !== "string"
    ) {
      return null;
    }
    return parsed as UploadSlotClaims;
  } catch {
    return null;
  }
}

/** Test-only: introspect without consuming. Not exported through the
 *  endpoint surface; only the tests reach for it. */
export async function peekUploadSlot(
  kv: KVNamespace,
  token: string
): Promise<UploadSlotClaims | null> {
  const raw = await kv.get(KV_PREFIX + token, "text");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UploadSlotClaims;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const __testing = {
  SLOT_TTL_SECONDS,
  KV_PREFIX,
  MAX_BYTES_DEFAULT,
};
