/**
 * Organizational domains, and the ONE list of domains nobody can own.
 *
 * Two decisions in this codebase ask "does this address belong to the same
 * organization as that website?":
 *
 *   - claim domain-matching (OPE-64, `src/lib/claims/domain-match.ts`), and
 *   - promoter-contact domain verification (OPE-1330).
 *
 * Both need the same two things: a PSL-aware organizational domain (eTLD+1,
 * so `events@mail.example.org` and `https://www.example.org` agree), and a
 * list of domains where sharing the domain proves NOTHING — free mailbox
 * providers and shared hosts where unrelated parties all sit under one
 * domain. That list lived privately inside the claim matcher; it lives here
 * now so the two decisions cannot drift apart.
 *
 * The free-mailbox half is OPE-856's `GENERIC_EMAIL_PROVIDERS`, reused as-is.
 * The shared-host half is new to this module but not new to the codebase:
 * every entry was already in the claim matcher's private list.
 *
 * ⚠️ Same rule as OPE-856: an entry here must be a domain where a shared
 * domain proves the parties are UNRELATED. Adding a real organizer's domain
 * would silently stop matching it.
 */
import { getDomain } from "tldts";
import { GENERIC_EMAIL_PROVIDERS } from "./email-providers";

/**
 * Hosts where many unrelated parties publish under one domain: social
 * networks, site builders, link shorteners, marketplaces. A promoter whose
 * "website" is a Facebook page does not own facebook.com.
 *
 * `google.com` is here because `sites.google.com/view/<anything>` resolves to
 * the organizational domain `google.com`.
 */
export const SHARED_HOST_DOMAINS: ReadonlySet<string> = new Set([
  // social
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  // link shorteners / link-in-bio
  "linktr.ee",
  "bit.ly",
  // site builders and hosted blogs
  "wordpress.com",
  "wix.com",
  "wixsite.com",
  "squarespace.com",
  "weebly.com",
  "blogspot.com",
  "godaddysites.com",
  "webflow.io",
  "square.site",
  "myshopify.com",
  "google.com",
  "googlebusiness.com",
  "business.site",
  // marketplaces / ticketing
  "etsy.com",
  "eventbrite.com",
]);

/** Mailbox providers the claim matcher blocked that OPE-856's list omits. */
const EXTRA_MAILBOX_PROVIDERS = ["yandex.com", "hey.com"];

/**
 * Every domain whose sharing proves nothing about ownership: free mailbox
 * providers (OPE-856) ∪ shared hosts ∪ the claim matcher's extra providers.
 */
export const NON_OWNABLE_DOMAINS: ReadonlySet<string> = new Set([
  ...GENERIC_EMAIL_PROVIDERS,
  ...SHARED_HOST_DOMAINS,
  ...EXTRA_MAILBOX_PROVIDERS,
]);

/**
 * The organizational (registrable, eTLD+1) domain of an email address, a bare
 * host, or a URL. PSL-aware: `a.b.example.co.uk` → `example.co.uk`. Null when
 * nothing parseable is there.
 */
export function organizationalDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  const at = v.lastIndexOf("@");
  if (at >= 0 && !v.includes("/")) v = v.slice(at + 1);
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v) && v.includes("/")) v = "https://" + v;
  return getDomain(v);
}

/** True when sharing this domain proves nothing about who owns it. */
export function isNonOwnableDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (NON_OWNABLE_DOMAINS.has(d)) return true;
  const org = organizationalDomain(d);
  return org !== null && NON_OWNABLE_DOMAINS.has(org);
}
