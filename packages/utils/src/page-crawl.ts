/**
 * OPE-837 — same-domain page discovery and classification for the submit@
 * extraction pipeline.
 *
 * ## The defect this exists for
 *
 * The inbound fan-out (OPE-55) enumerates URLs found in the EMAIL. Nothing
 * enumerated pages on the fetched SITE, so one URL in meant one page read.
 * A bare-URL submission of `https://mainecheesefestival.org/` extracted the
 * homepage correctly and never opened the eleven nav pages linked from it —
 * where the price, a 63-name exhibitor roster and the organizer identity all
 * lived. Three separate tickets (OPE-744 price citations, OPE-526 vendor-
 * application capture, OPE-175 roster enrichment) each asked for a field that
 * lives on a secondary page, and none of them could succeed while the
 * extractor never opened the page the field is printed on.
 *
 * ## Why classification happens TWICE
 *
 * `classifyFromHint` runs BEFORE fetching, on the URL slug plus the anchor
 * text of the link as it appeared on the parent page. `classifyPage` runs
 * AFTER, once the page's own heading is available, and may upgrade the guess.
 *
 * Both are needed, and the pre-fetch half is the load-bearing one: you must
 * decide WHICH pages are worth a fetch before you have fetched them. The
 * specimen is exactly the shape that makes this non-optional — every nav link
 * is `?page_id=<N>`, so the URL carries no slug signal whatsoever, and the
 * anchor text ("Tickets", "Artisan Vendors", "Cheesemakers", "Food Trucks")
 * is the ONLY pre-fetch signal that exists. A classifier written against
 * slugs alone would score zero on this site and fetch nothing.
 *
 * Everything here is pure — no I/O. The crawl orchestration lives in the
 * inbound-email workflow; this module only decides what is worth opening and
 * what it probably is.
 */

/**
 * What a secondary page is, for routing to a type-specific extractor.
 *
 * `other` is deliberately terminal: it means "we looked at the link and it
 * matched nothing", and pages that land there are NOT fetched. That keeps
 * this bounded nav-following on one domain rather than a spider — a site with
 * forty nav links costs us the five that look like they carry event fields,
 * not forty fetches.
 */
export type PageClass = "tickets" | "vendors" | "schedule" | "sponsors" | "faq" | "other";

/** A link as it appeared on the parent page: destination plus its anchor text. */
export interface DiscoveredLink {
  url: string;
  /** Visible anchor text, whitespace-collapsed. May be empty (image links). */
  text: string;
}

/** A page selected for crawling, with the pre-fetch reasoning that picked it. */
export interface CrawlTarget {
  url: string;
  anchorText: string;
  /** Pre-fetch classification from URL slug + anchor text. */
  hintClass: PageClass;
  /** Which signal produced `hintClass` — recorded in the workflow step so a
   *  misclassification is diagnosable without re-fetching the parent page. */
  matchedOn: "anchor-text" | "url-slug";
}

/**
 * Class token tables, most specific first.
 *
 * Order is load-bearing. "Food Trucks" must reach `vendors`, not `schedule`,
 * and a "Vendor Lineup" must not be read as an entertainment lineup — so
 * `vendors` is tested before `schedule`, which is where the bare `lineup`
 * token lives.
 */
const CLASS_PATTERNS: ReadonlyArray<readonly [PageClass, RegExp]> = [
  [
    "vendors",
    /\b(?:vendors?|exhibitors?|artisans?|makers?|cheesemakers?|crafters?|food\s*trucks?|concessions?|booths?|stalls?|marketplace|participants?)\b/i,
  ],
  [
    "tickets",
    /\b(?:tickets?|admissions?|pricing|prices?|buy|purchase|register|registration|box\s*office)\b/i,
  ],
  [
    "schedule",
    /\b(?:schedule|programming|program|agenda|line\s*-?\s*up|entertainment|performers?|music|attractions?|activities)\b/i,
  ],
  ["sponsors", /\b(?:sponsors?|sponsorship|partners?)\b/i],
  ["faq", /\b(?:faq|faqs|frequently\s+asked|questions)\b/i],
];

/**
 * Link shapes never worth fetching, whatever they are called.
 *
 * Media files matter here beyond politeness: the fetch route rejects PDFs
 * outright (`fetchMethod: 'pdf_unsupported'`), so following one spends a
 * request to earn a guaranteed failure.
 */
const EXCLUDED_PATH = /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|mov|ics|csv)$/i;
const EXCLUDED_HINT =
  /\b(?:wp-admin|wp-login|wp-content|cart|checkout|basket|my-account|login|signin|sign-in|logout|register-account|privacy|terms|cookie|sitemap|feed|rss|search)\b/i;

/**
 * Two-label public suffixes we actually meet on organizer sites.
 *
 * ⚠️ This is an APPROXIMATION of the Public Suffix List, not the list itself.
 * Pulling in a real PSL is a dependency and a monthly-refresh obligation for
 * a comparison that only ever runs between two hosts inside ONE submission —
 * the page the submitter sent us and a link printed on it. The failure mode of
 * being wrong is bounded accordingly: we either skip a page we could have
 * read, or read one same-site page we judged foreign. Neither writes anything.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "org.nz",
  "co.za",
  "com.br",
  "co.jp",
  "or.jp",
  "co.in",
  "com.mx",
]);

/**
 * Best-effort registrable domain ("example.org" from "www.example.org").
 *
 * Returns the lowercased host unchanged when it has too few labels to reduce.
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** True when both URLs sit on the same registrable domain. */
export function isSameSite(a: string, b: string): boolean {
  try {
    return registrableDomain(new URL(a).hostname) === registrableDomain(new URL(b).hostname);
  } catch {
    return false;
  }
}

/**
 * Third-party ticketing hosts.
 *
 * These exist because an organizer's own "Tickets" page is, on essentially
 * every small-festival site, a paragraph of prose and a button pointing at a
 * ticketing vendor. The prices are on the vendor's form, one hop off-site.
 * See `ONE_HOP` note in `selectTicketVendorLink`.
 */
const TICKET_VENDOR_HOSTS =
  /(?:^|\.)(?:eventbrite\.[a-z.]+|festivalpro\.com|ticketleap\.com|ticketmaster\.[a-z.]+|universe\.com|showpass\.com|tickettailor\.com|ticketspice\.com|simpletix\.com|eventzilla\.net|purplepass\.com|seetickets\.us|dice\.fm|humanitix\.com|trybooking\.com|zeffy\.com|givebutter\.com|brownpapertickets\.com|squareup\.com|square\.site|bigcartel\.com|eventcreate\.com)$/i;

/** True when the host is a known third-party ticketing/registration vendor. */
export function isTicketVendorHost(host: string): boolean {
  return TICKET_VENDOR_HOSTS.test(host.toLowerCase());
}

/**
 * Normalize a URL for dedup: drop the fragment and tracking params, and
 * collapse a trailing slash.
 *
 * `?page_id=54` must survive — on this specimen the query string IS the page
 * identity — so query parameters are preserved apart from a UTM/click-id
 * denylist rather than stripped wholesale.
 */
const TRACKING_PARAMS = /^(?:utm_|fbclid$|gclid$|mc_(?:cid|eid)$|_ga$|ref$|source$)/i;
export function normalizeUrlForDedup(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
    // Rebuild deterministically so param ORDER cannot make one page look like two.
    u.search = "";
    for (const [k, v] of keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      u.searchParams.append(k, v);
    }
    let s = u.toString();
    if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Classify a string (anchor text, heading, or slug) against the token tables. */
function classifyText(text: string): PageClass {
  for (const [cls, re] of CLASS_PATTERNS) {
    if (re.test(text)) return cls;
  }
  return "other";
}

/**
 * Pre-fetch classification, from the URL's own slug plus the anchor text that
 * linked to it.
 *
 * Anchor text is tried FIRST. On a WordPress `?page_id=N` site the slug is
 * literally a number and can only ever return `other`; the human-authored nav
 * label is the real signal. Slug is the fallback for sites that link with an
 * image or a bare "click here".
 */
export function classifyFromHint(link: DiscoveredLink): {
  cls: PageClass;
  matchedOn: "anchor-text" | "url-slug";
} {
  const byAnchor = classifyText(link.text);
  if (byAnchor !== "other") return { cls: byAnchor, matchedOn: "anchor-text" };

  let slugText = "";
  try {
    const u = new URL(link.url);
    // Path segments and query VALUES both carry slugs in the wild
    // (`/vendors`, but also `?page=vendors`). Numbers contribute nothing.
    slugText = `${u.pathname} ${[...u.searchParams.values()].join(" ")}`.replace(/[-_/+]/g, " ");
  } catch {
    slugText = link.url;
  }
  const bySlug = classifyText(slugText);
  return { cls: bySlug, matchedOn: "url-slug" };
}

/**
 * Post-fetch classification. The page's own heading outranks the pre-fetch
 * guess when it says something definite; otherwise the hint stands.
 *
 * Upgrading on the heading is what stops a vague nav label ("Learn More")
 * from permanently mis-routing a page whose H1 reads "2026 Artisan Vendors".
 */
export function classifyPage(input: {
  hintClass: PageClass;
  heading?: string | null;
  title?: string | null;
}): PageClass {
  const fromHeading = classifyText(input.heading ?? "");
  if (fromHeading !== "other") return fromHeading;
  if (input.hintClass !== "other") return input.hintClass;
  return classifyText(input.title ?? "");
}

export interface SelectCrawlTargetsOptions {
  /** Hard ceiling on pages fetched per submission. */
  cap?: number;
  /** Already-fetched URLs (the email's own sources) — never re-fetched. */
  alreadyFetched?: readonly string[];
}

/** Priority order for spending a limited fetch budget. */
const CLASS_PRIORITY: Record<PageClass, number> = {
  tickets: 0,
  vendors: 1,
  schedule: 2,
  sponsors: 3,
  faq: 4,
  other: 99,
};

export const DEFAULT_CRAWL_CAP = 15;

/**
 * Choose which same-site links are worth fetching, in priority order.
 *
 * Pages classified `other` are excluded rather than filling leftover budget.
 * That is what keeps the "single-page site with no nav produces exactly
 * today's behaviour and no extra fetches" property true by construction: a
 * site whose nav is Home/About/Contact classifies entirely to `other` and
 * yields an empty target list, so the crawl phase performs zero fetches
 * rather than spending its cap discovering that About pages hold no prices.
 */
export function selectCrawlTargets(
  links: readonly DiscoveredLink[],
  baseUrl: string,
  options: SelectCrawlTargetsOptions = {}
): CrawlTarget[] {
  const cap = options.cap ?? DEFAULT_CRAWL_CAP;
  const seen = new Set<string>([normalizeUrlForDedup(baseUrl)]);
  for (const u of options.alreadyFetched ?? []) seen.add(normalizeUrlForDedup(u));

  const picked: CrawlTarget[] = [];
  for (const link of links) {
    let parsed: URL;
    try {
      parsed = new URL(link.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (!isSameSite(link.url, baseUrl)) continue;
    if (EXCLUDED_PATH.test(parsed.pathname)) continue;
    if (EXCLUDED_HINT.test(`${parsed.pathname} ${parsed.search} ${link.text}`)) continue;

    const key = normalizeUrlForDedup(link.url);
    if (seen.has(key)) continue;

    const { cls, matchedOn } = classifyFromHint(link);
    if (cls === "other") continue;

    seen.add(key);
    picked.push({
      url: link.url,
      anchorText: link.text.slice(0, 120),
      hintClass: cls,
      matchedOn,
    });
  }

  // Stable priority sort: a ticket page is worth more than an FAQ when the cap
  // binds. `sort` is stable in every runtime we target, so within one class the
  // page order on the parent site is preserved.
  picked.sort((a, b) => CLASS_PRIORITY[a.hintClass] - CLASS_PRIORITY[b.hintClass]);
  return picked.slice(0, cap);
}

/**
 * The ONE off-site hop this crawler is allowed, and only from a ticket page.
 *
 * ⚠️ This is a deliberate, argued exception to the same-domain rule, not an
 * oversight. Measured on the specimen: the organizer's own Tickets page
 * (`?page_id=54`) contains 1,813 characters and ZERO prices — every price
 * lives on the festivalpro form it links to, which is a different registrable
 * domain. A strict same-domain crawl therefore cannot ever satisfy "the
 * resulting event carries a price range", because the price is not on the
 * domain. The two requirements are in direct conflict on this exact page, and
 * this hop is the narrowest thing that resolves it:
 *
 *   - only from a page already classified `tickets`
 *   - only to a host on the known ticketing-vendor list
 *   - at most ONE per submission
 *   - read-only: it contributes a price range and a purchase URL, nothing else
 *
 * It is not a general "follow outbound links" rule and must not become one.
 */
export function selectTicketVendorLink(
  links: readonly DiscoveredLink[],
  pageUrl: string
): DiscoveredLink | null {
  for (const link of links) {
    try {
      const u = new URL(link.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      if (isSameSite(link.url, pageUrl)) continue;
      if (isTicketVendorHost(u.hostname)) return link;
    } catch {
      continue;
    }
  }
  return null;
}
