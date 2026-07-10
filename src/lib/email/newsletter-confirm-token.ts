// Newsletter double opt-in confirmation tokens. The raw token only ever
// exists in the confirmation email URL; we store its SHA-256 hex digest
// on `newsletter_subscribers.confirmation_token_hash` so a DB compromise
// can't be used to silently confirm subscriptions.
//
// Mirrors src/lib/vendor-claim-token.ts's hash + single-use semantics.
// Difference: state lives inline on the subscriber row (column-per-token),
// not in a separate tokens table, because each subscriber has at most one
// outstanding token at a time. TTL intentionally DIVERGES from vendor-claim's
// 24h — OPE-168 widened the newsletter window to 14 days (industry-standard
// double opt-in) because the old 24h expiry was lapsing real signups before
// they clicked confirm. This constant is the single source of truth for the
// window (the confirmation email copy + /newsletter/confirmed expired page must
// state the same duration).

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { newsletterSubscribers } from "@/lib/db/schema";

const TOKEN_BYTE_LENGTH = 32;
/** OPE-168 — days a newsletter confirmation link stays valid. Widened from 1
 *  to 14 (real signups were expiring at 24h). Keep the user-facing copy in
 *  sync: templates.ts newsletter-confirm + the expired page. */
export const NEWSLETTER_CONFIRM_TTL_DAYS = 14;
const TOKEN_TTL_SECONDS = NEWSLETTER_CONFIRM_TTL_DAYS * 24 * 60 * 60;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

function generateRawToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

type Db = DrizzleD1Database<Record<string, unknown>>;

/**
 * Issue a new confirmation token for `email`. Idempotent on the row's
 * identity (one row per email by unique constraint), so re-issuing for an
 * unconfirmed subscriber OVERWRITES any prior outstanding token. That's
 * the correct behavior for the "user lost the email and re-submits"
 * case — old link goes dead, new one is the only valid one.
 *
 * Returns the RAW token (the only place it ever exists outside the
 * email URL) plus the absolute expiry. The DB only holds the hash.
 */
export async function issueNewsletterConfirmationToken(
  db: Db,
  email: string
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

  await db
    .update(newsletterSubscribers)
    .set({ confirmationTokenHash: tokenHash, confirmationExpires: expiresAt })
    .where(eq(newsletterSubscribers.email, email));

  return { rawToken, expiresAt };
}

export type ConfirmTokenResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not_found" | "expired" | "already_confirmed" };

/**
 * Validate a raw token and consume it: flips `confirmed=true`, clears the
 * stored hash + expiry, and unsets `unsubscribed` if the user is opting
 * back in via a fresh confirm. Caller (the GET endpoint) is responsible
 * for the post-consume UX — typically a 303 redirect to a success page.
 */
export async function consumeNewsletterConfirmationToken(
  db: Db,
  rawToken: string
): Promise<ConfirmTokenResult> {
  const tokenHash = await sha256Hex(rawToken);

  const [row] = await db
    .select({
      email: newsletterSubscribers.email,
      expires: newsletterSubscribers.confirmationExpires,
      confirmed: newsletterSubscribers.confirmed,
    })
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.confirmationTokenHash, tokenHash))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };

  // Already-confirmed case: a stale link was clicked AFTER an earlier
  // successful confirm. Treat as benign — the subscription is in the
  // desired state. UX returns a friendly "already confirmed" page.
  if (row.confirmed) {
    return { ok: false, reason: "already_confirmed" };
  }

  if (!row.expires || row.expires.getTime() < Date.now()) {
    // Clear the stale hash so the row can be re-issued cleanly on a
    // future re-subscribe (otherwise the next issue would orphan-overlay
    // it; harmless, but cleaner to wipe).
    await db
      .update(newsletterSubscribers)
      .set({ confirmationTokenHash: null, confirmationExpires: null })
      .where(eq(newsletterSubscribers.email, row.email));
    return { ok: false, reason: "expired" };
  }

  // Single-use: clear hash + expiry on consume, flip confirmed=true.
  // unsubscribed is cleared in case this is a re-opt-in flow.
  await db
    .update(newsletterSubscribers)
    .set({
      confirmed: true,
      unsubscribed: false,
      confirmationTokenHash: null,
      confirmationExpires: null,
    })
    .where(
      and(
        eq(newsletterSubscribers.email, row.email),
        // Race guard: another concurrent consume of the same token must
        // not double-confirm. The hash-equality check fails the second
        // time because the first consume already nulled it.
        eq(newsletterSubscribers.confirmationTokenHash, tokenHash)
      )
    );

  return { ok: true, email: row.email };
}

// Re-export for type-only consumers.
export type { Db as NewsletterConfirmTokenDb };
