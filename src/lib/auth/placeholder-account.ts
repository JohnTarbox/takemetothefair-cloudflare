/**
 * OPE-293 — ingestion placeholder accounts must never obtain a session.
 *
 * ## What a placeholder is
 *
 * When ingestion creates a vendor or promoter it needs an owner row, so it
 * mints a `users` row addressed `pending+<slug>@meetmeatthefair.com`. Nobody
 * signed up; nobody is expected to log in. Measured in prod 2026-08-18:
 * **6,824 of 7,038 users are placeholders — 97%.** They are legitimate and must
 * not be deleted; they own real vendor and promoter records.
 *
 * ## This is a regression guard, not a closed vulnerability
 *
 * Nothing here fixes a live hole. Measured the same day: **0 placeholders hold
 * a `password_hash` and 0 have an `accounts` (OAuth) row.** No placeholder can
 * authenticate today.
 *
 * What is missing is anything that KEEPS that true, and the safety turned out
 * to be thinner than the ticket assumed. It listed email-linking as a
 * hypothetical — "if a provider flow ever links by email". Two live paths
 * already do:
 *
 *   1. `signIn` (OAuth). An existing user WITHOUT a `passwordHash` falls
 *      through to having the provider account linked to it. Placeholders have
 *      no password hash by definition, so they are exactly the rows that link.
 *
 *   2. `forgot-password`. It looks up any `users` row by email and mails a
 *      reset token to `user.email` — i.e. to the placeholder mailbox. Complete
 *      the reset and the account has a credential, after which the ordinary
 *      credentials path works.
 *
 * Neither is exploitable today, and the reason is worth stating exactly,
 * because it is not the code: both chains terminate at **who can receive mail
 * at, or have a provider attest, `pending+<slug>@meetmeatthefair.com`**. That
 * is our own domain. A Cloudflare Email Routing catch-all, a new `+`-addressing
 * rule, or a Workspace change would move that line without anyone touching an
 * auth file — which is precisely the failure the ticket predicted.
 *
 * ## One predicate, deliberately
 *
 * Every guard reads this function so OPE-292 can retarget it — from the email
 * pattern to an explicit provenance column — by editing one body rather than
 * hunting call sites. That column does not exist yet (verified against prod
 * `pragma_table_info`), so the pattern is the interim, as the ticket allows.
 */

/**
 * The address shape ingestion mints. Anchored at both ends: a user who signed
 * up as `notpending+x@meetmeatthefair.com`, or `pending+x@gmail.com`, is a real
 * person and must not be locked out.
 */
const PLACEHOLDER_PREFIX = "pending+";
const PLACEHOLDER_DOMAIN = "@meetmeatthefair.com";

/**
 * True when `email` belongs to an ingestion-created placeholder.
 *
 * Case- and whitespace-insensitive: email local-parts are case-sensitive per
 * RFC 5321 but no mail system in practice treats them so, and a guard that let
 * `Pending+Foo@…` through would be a guard in name only.
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return normalized.startsWith(PLACEHOLDER_PREFIX) && normalized.endsWith(PLACEHOLDER_DOMAIN);
}

/**
 * The reason a placeholder was refused, for logs.
 *
 * Deliberately NOT surfaced to the caller of an auth flow. Telling an
 * unauthenticated visitor "that address is an ingestion placeholder" confirms
 * which of our synthetic accounts exist, and the flows this guards already
 * answer uniformly by design — `forgot-password` returns the same payload
 * whether or not the address is known.
 */
export const PLACEHOLDER_REFUSAL =
  "ingestion placeholder account (OPE-293): synthetic owner row, never authenticatable";
