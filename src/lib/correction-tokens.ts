/**
 * Issue + verify single-use tokens for the B4 pre-filled correction form.
 *
 * Token shape: 32-byte random buffer, base64url-encoded (~43 chars). Long
 * enough that brute-force guessing is impractical; URL-safe; no padding.
 *
 * Lifecycle:
 *   - issueCorrectionToken: workflow calls this in the send-reply step
 *     when emitting an ok-medium / ok-low reply that wants to invite the
 *     sender to a correction form. Inserts a row in
 *     submission_correction_tokens bound to (event_id, inbound_email_id).
 *   - lookupCorrectionToken: GET /submit-event/<token> calls this; returns
 *     the row + a `status` discriminator (live / used / expired / not-found)
 *     so the page renders the right UI without leaking which case applied.
 *   - consumeCorrectionToken: POST /api/submit-event/<token> calls this
 *     to mark used_at. Atomic — if it returns false, the page should
 *     refuse the write (token was claimed between GET render and POST).
 */

import { eq, and, isNull } from "drizzle-orm";
import { submissionCorrectionTokens } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 30;

/** Base64url-encode without padding. URL-safe alphabet, drop trailing =. */
function toBase64Url(bytes: Uint8Array): string {
  // Workers + Node both have a global `btoa`, but it only accepts strings.
  // Convert via String.fromCharCode on small buffers (32 bytes is fine for
  // this approach; for larger buffers a chunked converter would be needed).
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a new correction token and persist it. Caller is responsible for
 * passing the eventId of the freshly-created PENDING event and the
 * inboundEmailId that produced it (both required for audit trail).
 *
 * Returns the bare token string. Callers compose the URL via
 * `${MAIN_APP_URL}/submit-event/${token}`.
 */
export async function issueCorrectionToken(
  db: Db,
  args: { eventId: string; inboundEmailId: string }
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const token = toBase64Url(bytes);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(submissionCorrectionTokens).values({
    token,
    eventId: args.eventId,
    inboundEmailId: args.inboundEmailId,
    expiresAt,
    usedAt: null,
    createdAt: now,
  });
  return token;
}

export type CorrectionTokenStatus =
  | { status: "live"; eventId: string }
  | { status: "used"; eventId: string }
  | { status: "expired"; eventId: string }
  | { status: "not-found" };

/**
 * Read-only lookup. Returns a discriminated union so the caller doesn't
 * need to know about expires_at / used_at; "live" means the form should
 * render and accept a POST, anything else means show a status message.
 */
export async function lookupCorrectionToken(db: Db, token: string): Promise<CorrectionTokenStatus> {
  if (!token || token.length < 16) return { status: "not-found" };
  const rows = await db
    .select()
    .from(submissionCorrectionTokens)
    .where(eq(submissionCorrectionTokens.token, token))
    .limit(1);
  if (rows.length === 0) return { status: "not-found" };
  const row = rows[0];
  if (row.usedAt) return { status: "used", eventId: row.eventId };
  if (row.expiresAt.getTime() < Date.now()) return { status: "expired", eventId: row.eventId };
  return { status: "live", eventId: row.eventId };
}

/**
 * Atomically mark a token as used. Returns true on success, false if the
 * token had already been consumed (race between two concurrent POSTs, or
 * a double-click). Caller should treat false as a hard rejection.
 *
 * Uses `WHERE used_at IS NULL` to make this race-safe: the UPDATE
 * affects 0 rows if someone else already won the race, and Drizzle's
 * `returning()` lets us detect that case without a follow-up SELECT.
 */
export async function consumeCorrectionToken(db: Db, token: string): Promise<boolean> {
  const result = await db
    .update(submissionCorrectionTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(submissionCorrectionTokens.token, token), isNull(submissionCorrectionTokens.usedAt))
    )
    .returning({ token: submissionCorrectionTokens.token });
  return result.length > 0;
}
