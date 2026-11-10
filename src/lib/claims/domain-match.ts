/**
 * Domain-match decision core — OPE-64 (rung 2 of the claim ladder).
 *
 * SECURITY-CRITICAL. This is a PURE, side-effect-free decision function: it
 * compares the registrable domain (eTLD+1, PSL-aware) of the account email
 * against the registrable domain of the entity's STORED website. It NEVER
 * fetches the website (SSRF constraint K30) — sharing a real business domain
 * between the account email and the listing's website is the only thing that
 * counts as a domain match.
 *
 * Freemail providers, free site-builders, social networks, and marketplaces are
 * explicitly blocked: sharing e.g. `gmail.com` or `facebook.com` proves nothing
 * about ownership of a specific listing, so those registrable domains can NEVER
 * produce a match on either side.
 */
import { getDomain } from "tldts";
import { isNonOwnableDomain } from "@takemetothefair/utils";

// Registrable domains that must NEVER count as a domain match live in ONE
// place, shared with promoter-contact domain verification (OPE-1330):
// `NON_OWNABLE_DOMAINS` in @takemetothefair/utils — freemail (OPE-856) +
// free site-builders / social / marketplaces. Every entry this file used to
// hold privately is in it (pinned by domain-match-shared-list-ope1330.test.ts).

export type DomainMatchResult =
  | { match: true; registrableDomain: string }
  | {
      match: false;
      reason:
        | "no_email"
        | "no_website"
        | "unparseable_email"
        | "unparseable_website"
        | "non_matchable_email"
        | "non_matchable_website"
        | "different_domain";
    };

export function registrableDomainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const host = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!host) return null;
  return getDomain(host); // eTLD+1 (PSL-aware) or null
}

export function registrableDomainFromWebsite(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u; // tldts getDomain accepts URLs
  return getDomain(u);
}

/**
 * `website` is the stored website, OR (OPE-1614) the entity's matchable
 * domain list from `matchableDomainsFor` — its website host plus every
 * domain established for it, with shared domains already left out. Either
 * way it is STORED data: nothing here fetches anything.
 */
export function decideDomainMatch(
  email: string | null | undefined,
  website: string | readonly string[] | null | undefined
): DomainMatchResult {
  const sites = (typeof website === "string" ? [website] : (website ?? [])).filter(
    (s) => s.trim().length > 0
  );
  if (!email) return { match: false, reason: "no_email" };
  if (sites.length === 0) return { match: false, reason: "no_website" };
  const e = registrableDomainFromEmail(email);
  if (!e) return { match: false, reason: "unparseable_email" };
  const ws = sites.map(registrableDomainFromWebsite).filter((w): w is string => !!w);
  if (ws.length === 0) return { match: false, reason: "unparseable_website" };
  if (isNonOwnableDomain(e)) return { match: false, reason: "non_matchable_email" };
  const ownable = ws.filter((w) => !isNonOwnableDomain(w));
  if (ownable.length === 0) return { match: false, reason: "non_matchable_website" };
  if (!ownable.includes(e)) return { match: false, reason: "different_domain" };
  return { match: true, registrableDomain: e };
}
