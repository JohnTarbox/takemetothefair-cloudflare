/**
 * OPE-601 — one normalizer for the email identity key.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * `users.email` was compared, and made unique, case-SENSITIVELY — but only on
 * some paths. The result was not one bug but an inconsistency, and the
 * inconsistency is what made it invisible:
 *
 *   register           did NOT fold case  -> `Admin@x.com` registers alongside
 *                                            an existing `admin@x.com`
 *   login (auth.ts)    did NOT fold case  -> typing `Admin@` finds nothing
 *   forgot-password    DID fold the input -> finds a lowercase-stored row
 *   send-verification  DID fold the input -> same
 *
 * Jan Merrill's 2026-08-07 timeline is that table read top to bottom. She reset
 * her password successfully (folded path), then failed to sign in as `Admin@`
 * (unfolded path), concluded she had no account, registered again (unfolded
 * path let her), and that registration 500'd on her own `vendors.slug`.
 *
 * ── The half the ticket did not have ────────────────────────────────────────
 * Nine `users` rows are stored with a capital letter. Eight are NOT duplicates
 * — they are the only account that person has. For all eight, the folding
 * mismatch runs the other way: `forgot-password` lowercases the input and then
 * matches `eq(users.email, …)` against a row stored capitalised, so it never
 * matches — and that route returns `GENERIC_OK` whether or not the address is
 * known, for enumeration safety. So those users cannot sign in unless they
 * reproduce their own capitalisation exactly, cannot reset their password, and
 * are told nothing is wrong. A silent lockout.
 *
 * ── Why a shared helper rather than `.toLowerCase()` at each site ───────────
 * Two of the five sites already called `.toLowerCase().trim()`. Having it at
 * *some* sites is precisely what produced a state where password reset works
 * and login does not, which is more confusing to a user than either failing
 * outright. One function, imported everywhere, is the thing that can be
 * enforced by a test.
 *
 * Lowercasing the whole address, including the local part, is deliberate.
 * RFC 5321 leaves local-part case to the receiving host, but the same RFC
 * discourages relying on it and no major provider distinguishes it — Gmail,
 * Outlook, Yahoo and Apple all fold. A user who capitalises their own address
 * has not entered a different one.
 */

/**
 * The identity key for an email address: trimmed and lowercased.
 *
 * Use for every write to `users.email` and every lookup keyed on it. Returns
 * "" for nullish input so callers can treat empty as "no address" without a
 * separate guard.
 */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}
