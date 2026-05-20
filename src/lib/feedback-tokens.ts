/**
 * Signed-token lifecycle for the Phase D.3 sender feedback widgets.
 *
 * Mirrors the existing src/lib/vendor-claim-token.ts pattern:
 * - issueToken: 32 random bytes → base64url → INSERT row → return
 *   the raw token. The DB row IS the validity record; no HMAC secret
 *   to rotate, no signed payload to verify.
 * - consumeToken: lookup, expiry check, used_at check, mark used,
 *   return metadata. Idempotent — second consume returns null.
 * - verifyTokenForRead: same checks WITHOUT marking used. Used by
 *   the follow-up form GET so loading the form doesn't burn the
 *   single click.
 *
 * Token lifetime: 60 days (configurable via TOKEN_TTL_DAYS). Spec
 * §D.3.5 — "stale tokens auto-invalidate."
 */

import { eq, and, isNull, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { inboundEmailFeedbackTokens } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export type FeedbackMoment = "receipt" | "approval" | "other";

const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 60;

export interface IssueArgs {
  inboundEmailId: string;
  feedbackMoment: FeedbackMoment;
  resultingEventId?: string | null;
  ttlDays?: number;
}

export interface TokenMetadata {
  inboundEmailId: string;
  feedbackMoment: FeedbackMoment;
  resultingEventId: string | null;
}

/** Generate a fresh 32-byte token, base64url-encode it, INSERT a row,
 *  and return the encoded token string. Caller embeds it in an outbound
 *  email URL like `https://meetmeatthefair.com/feedback/<token>?v=...`. */
export async function issueToken(db: Db, args: IssueArgs): Promise<string> {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = base64UrlEncode(raw);

  const now = new Date();
  const ttlDays = args.ttlDays ?? TOKEN_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 86400 * 1000);

  await db.insert(inboundEmailFeedbackTokens).values({
    token,
    inboundEmailId: args.inboundEmailId,
    feedbackMoment: args.feedbackMoment,
    resultingEventId: args.resultingEventId ?? null,
    issuedAt: now,
    expiresAt,
    usedAt: null,
  });

  return token;
}

/**
 * Look up + consume the token. Returns null if not found, expired, or
 * already used. On success marks used_at and returns the token's
 * metadata so the caller can record the feedback against the right
 * inbound_email_id and resulting event.
 *
 * The UPDATE uses a WHERE clause on used_at IS NULL so two concurrent
 * consumes race-resolve to one winner (second one's UPDATE matches 0
 * rows, returns null).
 */
export async function consumeToken(db: Db, rawToken: string): Promise<TokenMetadata | null> {
  if (!rawToken || rawToken.length < 16) return null;

  const rows = await db
    .select({
      inboundEmailId: inboundEmailFeedbackTokens.inboundEmailId,
      feedbackMoment: inboundEmailFeedbackTokens.feedbackMoment,
      resultingEventId: inboundEmailFeedbackTokens.resultingEventId,
      expiresAt: inboundEmailFeedbackTokens.expiresAt,
      usedAt: inboundEmailFeedbackTokens.usedAt,
    })
    .from(inboundEmailFeedbackTokens)
    .where(eq(inboundEmailFeedbackTokens.token, rawToken))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.usedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  const updated = await db
    .update(inboundEmailFeedbackTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(inboundEmailFeedbackTokens.token, rawToken), isNull(inboundEmailFeedbackTokens.usedAt))
    )
    .returning({ token: inboundEmailFeedbackTokens.token });
  if (updated.length === 0) return null; // raced with another request

  return {
    inboundEmailId: row.inboundEmailId,
    feedbackMoment: row.feedbackMoment as FeedbackMoment,
    resultingEventId: row.resultingEventId,
  };
}

/** Same lookup-and-check as consumeToken, but doesn't mark used.
 *  Used by the follow-up form GET so the sender can load the page
 *  and then submit without burning the token on page-load. */
export async function verifyTokenForRead(db: Db, rawToken: string): Promise<TokenMetadata | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const rows = await db
    .select({
      inboundEmailId: inboundEmailFeedbackTokens.inboundEmailId,
      feedbackMoment: inboundEmailFeedbackTokens.feedbackMoment,
      resultingEventId: inboundEmailFeedbackTokens.resultingEventId,
      expiresAt: inboundEmailFeedbackTokens.expiresAt,
      usedAt: inboundEmailFeedbackTokens.usedAt,
    })
    .from(inboundEmailFeedbackTokens)
    .where(eq(inboundEmailFeedbackTokens.token, rawToken))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.usedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    inboundEmailId: row.inboundEmailId,
    feedbackMoment: row.feedbackMoment as FeedbackMoment,
    resultingEventId: row.resultingEventId,
  };
}

/** Bulk-expire stale tokens. Not wired to a cron; admin can call from
 *  a future cleanup endpoint. Cheap with the expires_at index. */
export async function sweepExpiredTokens(db: Db): Promise<number> {
  const result = await db
    .delete(inboundEmailFeedbackTokens)
    .where(
      and(
        lt(inboundEmailFeedbackTokens.expiresAt, new Date()),
        isNull(inboundEmailFeedbackTokens.usedAt)
      )
    )
    .returning({ token: inboundEmailFeedbackTokens.token });
  return result.length;
}

function base64UrlEncode(bytes: Uint8Array): string {
  // CF Workers has `btoa`. Avoid Buffer; not available on edge.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
