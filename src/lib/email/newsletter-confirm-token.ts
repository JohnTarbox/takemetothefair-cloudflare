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
import { addToList, listForSource } from "./newsletter-list-membership";

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
      id: newsletterSubscribers.id,
      email: newsletterSubscribers.email,
      // OPE-510 — the signup surface decides which audience list this is.
      source: newsletterSubscribers.source,
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
    // OPE-510 — self-healing, and worth the extra write.
    //
    // Every subscriber confirmed between 2026-08-10 and this fix is
    // `confirmed=1` with NO list row, so the broadcast skips them silently. A
    // stale link re-clicked is the one moment we hear from such a person, and
    // upserting here puts them back on the list at no cost — `addToList` is
    // idempotent, so for an already-listed subscriber this is a no-op.
    await addToList(db, row.id, listForSource(row.source));
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
      // OPE-389 — stamped in the SAME write as the flag. A separate write could
      // leave `confirmed=1` with a NULL timestamp if it failed, which is the
      // unobservable state this ticket exists to remove.
      confirmedAt: new Date(),
      unsubscribed: false,
      // Re-opt-in: clear the previous unsubscribe stamp so it always describes
      // the CURRENT state rather than a stale earlier cycle.
      unsubscribedAt: null,
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

  // OPE-510 — put them on the audience list.
  //
  // `newsletter_list_subscriptions` shipped with OPE-191 and the signup wiring
  // was deferred, while the SAME increment switched the weekend broadcast to
  // read that table. So a deferral scoped to the vendor list became a silent
  // delivery hole on the public one: eight people double-opted-in and received
  // nothing, and three more were stranded in the two days after the backfill.
  //
  // AFTER the confirm write, not before: if the confirm update fails we have
  // not put an unconfirmed address on a mailing list. And deliberately NOT
  // inside the same statement — a list write that throws must not roll back a
  // consent record the subscriber already earned. The canary in
  // `newsletter-list-membership.ts` is what catches the residual case where
  // this line fails while the confirm succeeds; before this ticket there was
  // nothing comparing the two counts at all, which is why it hid for 11 days.
  await addToList(db, row.id, listForSource(row.source));

  return { ok: true, email: row.email };
}

// Re-export for type-only consumers.
export type { Db as NewsletterConfirmTokenDb };
