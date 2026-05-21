/**
 * Source-tier classifier for B5 dedup enrichment (Phase 1 log-only).
 *
 * When a duplicate submission arrives, we want to know whether the new
 * source is more authoritative than the existing event's source. The
 * classifier returns one of three tiers, ordered most-authoritative first:
 *
 *   T1 — organizer's own site. Hostname matches the event's contact-email
 *        domain or promoter site, OR appears in the curated organizer
 *        list. The bar is high: this is the ground truth for dates,
 *        cancellations, vendor info.
 *   T2 — DMO / regional tourism / chamber-of-commerce / government.
 *        Hostname matches the curated DMO list, or is a `.gov` /
 *        `.tourism.*` host. These sites usually copy organizer info
 *        with a 24–72h lag and occasionally get details wrong, but are
 *        more reliable than aggregators.
 *   T3 — aggregator / general-content / social media. Everything else,
 *        including event-aggregator sites, hyperlocal news, Facebook
 *        events, etc. Most submissions come from here.
 *
 * Compare with `compareTier(a, b)`: negative = `a` is more authoritative,
 * positive = `b` is more authoritative, zero = equal.
 *
 * Phase 1: read-only — `inbound-email` workflow uses this to write an
 * admin_actions row when a duplicate came in at a higher tier than the
 * existing event. Phase 2 (after a week of clean logs) flips the
 * if-branch to actually re-extract and overwrite.
 */

export type SourceTier = "T1" | "T2" | "T3";

export interface ClassifyContext {
  /** Promoter / suggester contact-email domain, lowercase. Used as the
   *  T1 signal: if the candidate hostname's eTLD+1 matches this, the
   *  candidate is the organizer's own site. */
  contactEmailDomain?: string | null;
  /** Promoter's known website host, lowercase (eTLD+1). Same T1 signal,
   *  for promoters whose contact email is on a generic domain (gmail,
   *  yahoo) but whose own site is the authoritative URL. */
  promoterHost?: string | null;
}

/**
 * Curated DMO / regional tourism hostnames. T2 fallback when the
 * candidate URL doesn't match a T1 signal. Hosts here are eTLD+1
 * (e.g. "visitmaine.com", not "www.visitmaine.com"). Add to this list
 * as new DMOs surface in the Phase 1 logs.
 */
const KNOWN_DMO_HOSTS: ReadonlySet<string> = new Set([
  // Maine
  "visitmaine.com",
  "mainetourism.com",
  "downeast.com",
  "visitportland.com",
  "visitbangor.com",
  "visitfreeport.com",
  "visitcamden.com",
  // New Hampshire
  "visitnh.gov",
  "lakesregion.org",
  "visitwhitemountains.com",
  // Vermont
  "vermontvacation.com",
  "vermont.com",
  // Massachusetts
  "visitma.com",
  "massvacation.com",
  "berkshires.org",
  "visitboston.com",
  "visitcapecod.com",
  // Rhode Island
  "visitrhodeisland.com",
  "newportri.com",
  // Connecticut
  "ctvisit.com",
  "visitctri.com",
]);

/**
 * Domain suffixes that imply T2. Order doesn't matter — first match wins.
 * Conservative on purpose: a `.gov` site is almost always authoritative
 * for the events it lists (parks, towns, libraries), and a host that
 * starts with `visit` is by convention a regional tourism site.
 */
const T2_HOST_PATTERNS: readonly RegExp[] = [
  /\.gov$/i,
  /(^|\.)visit[a-z]+\.(com|org|gov)$/i,
  /(^|\.)tourism\.[a-z]+/i,
  /(^|\.)[a-z]+tourism\.(com|org|gov)$/i,
  /(^|\.)chamber\.(com|org)$/i,
  /chamberofcommerce/i,
];

/**
 * Extract the eTLD+1 (registrable domain) for hostname matching.
 * Without a true PSL lookup we approximate by taking the last two
 * labels for .com/.org/.net hosts and the last three for known
 * second-level public suffixes (.co.uk, .gov.uk, etc.). Good enough
 * for the DMO list — none of those hosts are on multi-label TLDs.
 */
function eTldPlusOne(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/:\d+$/, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  const PUBLIC_2LD = /^(co|gov|org|net|ac)\.[a-z]{2}$/i;
  if (PUBLIC_2LD.test(lastTwo)) return lastThree;
  return lastTwo;
}

/**
 * Pull a hostname from a URL string. Returns null when the input
 * isn't a valid absolute URL.
 */
function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Classify a URL's source tier. Pure function; safe to call from any layer.
 */
export function classifyDomainTier(
  url: string | null | undefined,
  ctx: ClassifyContext = {}
): SourceTier {
  const host = urlHost(url);
  if (!host) return "T3";

  const registrable = eTldPlusOne(host);

  // T1: organizer match. Compare against the event's contact-email
  // domain and the promoter's known site host. Both inputs should
  // already be eTLD+1; if not we coerce.
  if (ctx.contactEmailDomain) {
    const ce = eTldPlusOne(ctx.contactEmailDomain);
    if (ce === registrable) return "T1";
  }
  if (ctx.promoterHost) {
    const ph = eTldPlusOne(ctx.promoterHost);
    if (ph === registrable) return "T1";
  }

  // T2: DMO / tourism / .gov / chamber.
  if (KNOWN_DMO_HOSTS.has(registrable)) return "T2";
  for (const re of T2_HOST_PATTERNS) {
    if (re.test(host)) return "T2";
  }

  return "T3";
}

/**
 * Compare two tiers. Returns negative when `a` is more authoritative
 * than `b`, positive when `b` is more authoritative, zero when equal.
 * Suitable for use as an Array.sort comparator if needed later.
 */
export function compareTier(a: SourceTier, b: SourceTier): number {
  const rank: Record<SourceTier, number> = { T1: 1, T2: 2, T3: 3 };
  return rank[a] - rank[b];
}

/**
 * Convenience: returns true when `candidate` is strictly more
 * authoritative than `existing`. Used by the dedup-enrichment branch
 * to decide whether the incoming source warrants a log entry.
 */
export function isHigherTier(candidate: SourceTier, existing: SourceTier): boolean {
  return compareTier(candidate, existing) < 0;
}
