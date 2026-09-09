/**
 * OPE-856 — mailbox providers that identify a PERSON'S MAILBOX, never a business.
 *
 * ## The failure
 *
 * `senderNameVariants("someone@gmail.com")` pushed both `gmail` and
 * `gmail.com` as candidate business names. `brandKey("gmail.com")` is
 * `"gmailcom"` — eight characters, so it clears the fragment matcher's
 * six-character gate — and it substring-matches the vendor whose
 * `businessName` is the bare address `craftigalcreative@gmail.com`.
 *
 * Result: **6 of 12** real inbound emails in the 2026-09-09 audit census — every
 * gmail sender — carried a false "existing vendor" match against a business
 * none of them had heard of. The briefing did warn that the match was only a
 * fragment, but the operator still has to read a wrong name and discard it, and
 * one sender matched the wrong vendor minutes before his real record matched on
 * contact-email.
 *
 * ## Why a denylist and not a heuristic
 *
 * The set is small, closed, and changes about once a decade. A heuristic
 * ("domains with many distinct senders") would need a corpus, would be wrong
 * for the first sender on a new provider, and could silently start excluding a
 * real vendor's own domain if that vendor happened to be popular — the failure
 * direction that loses a true match rather than dropping a false one.
 *
 * ⚠️ This list must contain ONLY domains where a shared domain proves the
 * senders are unrelated. It is not a spam list and not a disposable-address
 * list. Adding `example-fair.org` here because one sender misbehaved would
 * silently stop matching a real organizer.
 */
export const GENERIC_EMAIL_PROVIDERS: ReadonlySet<string> = new Set([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  // Yahoo / AOL
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // ISPs still common on New England small-business mail
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "cox.net",
  "charter.net",
  "roadrunner.com",
  "myfairpoint.net",
  "metrocast.net",
  // Privacy-forward providers
  "proton.me",
  "protonmail.com",
  "pm.me",
  "zoho.com",
  "gmx.com",
  "mail.com",
  "fastmail.com",
  "hushmail.com",
]);

/** True when this domain is a mailbox provider rather than a business's own. */
export function isGenericEmailProvider(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return GENERIC_EMAIL_PROVIDERS.has(
    domain
      .trim()
      .toLowerCase()
      .replace(/^www\./, "")
  );
}

/**
 * Is this string a bare email address on a generic provider?
 *
 * OPE-856 scope 2: a vendor whose `businessName` is literally
 * `craftigalcreative@gmail.com` must not be reachable by FRAGMENT matching —
 * the only distinctive thing about it is the local part, and the provider half
 * is what every unrelated sender collides with. An exact contact-email match
 * still finds it, which is the correct way to reach that row.
 */
export function isBareGenericProviderAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  const at = v.indexOf("@");
  if (at <= 0 || v.indexOf("@", at + 1) !== -1) return false;
  if (/\s/.test(v)) return false;
  return isGenericEmailProvider(v.slice(at + 1));
}
