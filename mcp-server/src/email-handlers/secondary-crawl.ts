/**
 * OPE-837 — bounded same-site nav crawl for the submit@ extraction pipeline.
 *
 * ## What this is
 *
 * After the pipeline fetches a submitted URL, this opens the pages that URL's
 * own navigation links to, classifies each, and routes it to a type-specific
 * extractor. It exists because the fan-out dimension was URLs in the EMAIL and
 * never pages on the SITE, so a bare-URL submission read one page and stopped —
 * leaving a price range and a 63-name exhibitor roster one hop away and
 * structurally unreachable.
 *
 * ## What this is NOT
 *
 * Not a spider. It follows nav links on ONE domain that a submitter explicitly
 * pointed us at, at most `DEFAULT_CRAWL_CAP` pages, only pages whose link text
 * or slug classifies to something that carries event fields, obeying
 * robots.txt and a per-host delay. Discovered pages are never themselves
 * treated as new event sources — they enrich the event the PRIMARY page
 * produced, fill-empty-only.
 *
 * ## Why the fetchers are injected
 *
 * The orchestration is the part with the interesting rules (robots, cap,
 * ordering, fill-empty-only) and the part most likely to regress. Injecting
 * `fetchPage` / `fetchRobots` lets all of it be tested without network, and
 * lets the workflow wrap each real fetch in its own durable `step.do` so a
 * crawl that dies halfway resumes instead of restarting.
 */
import {
  selectCrawlTargets,
  selectTicketVendorLink,
  classifyPage,
  extractInlineRoster,
  parseAdmissionPrices,
  DEFAULT_CRAWL_CAP,
  type PageClass,
  type DiscoveredLink,
} from "@takemetothefair/utils";
import {
  parseRobots,
  allowAll,
  denyAll,
  robotsUrlFor,
  robotsUnavailableMeansStop,
  effectiveCrawlDelayMs,
  type RobotsRules,
} from "@takemetothefair/site-fetch";

/** What one fetched page looks like to the crawler. */
export interface CrawlFetchResult {
  url: string;
  content: string;
  title: string | null;
  links: Array<{ url: string; text: string }>;
}

/** Per-page record. One of these becomes one workflow step (scope 5). */
export interface CrawledPageRecord {
  url: string;
  anchorText: string;
  /** Classification before the fetch, from anchor text or URL slug. */
  hintClass: PageClass;
  /** Classification after the fetch, once the page heading was available. */
  finalClass: PageClass | null;
  outcome: "ok" | "fetch-failed" | "robots-disallowed" | "no-fields";
  /** Event fields this page produced. Empty is a legitimate, recorded result. */
  producedFields: string[];
  /** Roster names found here, when it was a vendor page. */
  rosterCount: number;
  textChars: number;
  /** True for the single off-site ticket-vendor hop. */
  offSiteTicketHop: boolean;
}

/** The page a crawl-derived field was actually read from. */
export interface CrawlFieldSource {
  url: string;
  title: string | null;
  text: string;
  fetchedAt: Date;
}

export interface CrawlEnrichment {
  ticketUrl: string | null;
  ticketPriceMin: number | null;
  ticketPriceMax: number | null;
  /**
   * The page the ticket price came from.
   *
   * Load-bearing for provenance, not diagnostics. The citation writer
   * attributes every tracked field on an event to the source that produced the
   * EVENT — the primary page. A crawl-filled price did not come from there;
   * on the specimen it comes from a different registrable domain entirely.
   * Citing it against the primary page would assert that the homepage stated
   * $10-$35, which it does not, and that is precisely the false-attribution
   * defect OPE-457 ruled on. So the crawl carries its own source and the
   * workflow cites it separately.
   */
  priceSource: CrawlFieldSource | null;
  /** Deduped exhibitor names across every vendor page. */
  rosterNames: string[];
  /** One per page considered; the workflow writes these as steps. */
  pages: CrawledPageRecord[];
  /** Pages actually fetched (excludes robots-disallowed and skipped). */
  fetchCount: number;
  /** Wall-clock spent, for the cost line the ticket asks for. */
  elapsedMs: number;
  /** Total characters of page text read — the token-cost proxy. */
  textCharsFetched: number;
  robots: "allowed" | "partially-disallowed" | "unavailable-stop" | "none";
}

export interface CrawlDeps {
  /** Fetch one page. Return null on any failure — the crawl continues. */
  fetchPage(url: string): Promise<CrawlFetchResult | null>;
  /** Fetch robots.txt. Return the body and status, or null on network error. */
  fetchRobots(url: string): Promise<{ status: number; body: string } | null>;
  /** Wait between requests to one host. Injected so tests do not sleep. */
  wait(ms: number): Promise<void>;
  /** User-agent token to match robots groups against. */
  userAgent?: string;
}

export interface CrawlOptions {
  cap?: number;
  /** URLs the email itself already caused us to fetch. */
  alreadyFetched?: readonly string[];
}

export const CRAWL_USER_AGENT = "MeetMeAtTheFairBot";

/** An empty result, for the paths that legitimately crawl nothing. */
function emptyEnrichment(robots: CrawlEnrichment["robots"]): CrawlEnrichment {
  return {
    ticketUrl: null,
    ticketPriceMin: null,
    ticketPriceMax: null,
    priceSource: null,
    rosterNames: [],
    pages: [],
    fetchCount: 0,
    elapsedMs: 0,
    textCharsFetched: 0,
    robots,
  };
}

/** First heading-ish line of extracted text, used to refine classification. */
function headingOf(page: CrawlFetchResult): string {
  // The fetch route's text extraction puts the page title/H1 near the front;
  // the title tag is the more reliable of the two and is already parsed.
  return page.title ?? page.content.slice(0, 120);
}

/**
 * Crawl the nav pages of an already-fetched primary page.
 *
 * Returns enrichment only — it never writes anything. Application to an event
 * is `applyCrawlEnrichment`, which is fill-empty-only.
 */
export async function crawlSecondaryPages(
  primary: CrawlFetchResult,
  deps: CrawlDeps,
  options: CrawlOptions = {}
): Promise<CrawlEnrichment> {
  const startedAt = Date.now();
  const cap = options.cap ?? DEFAULT_CRAWL_CAP;

  const targets = selectCrawlTargets(primary.links as DiscoveredLink[], primary.url, {
    cap,
    alreadyFetched: options.alreadyFetched,
  });

  // A site whose nav carries no event-bearing pages costs ZERO fetches — not
  // even robots.txt. This is the "single-page site produces exactly today's
  // behaviour and no extra fetches" acceptance clause, satisfied by ordering
  // rather than by a special case.
  if (targets.length === 0) return emptyEnrichment("none");

  // ── robots.txt, once per crawl ────────────────────────────────────────
  let rules: RobotsRules = allowAll();
  let robotsState: CrawlEnrichment["robots"] = "none";
  const robotsUrl = robotsUrlFor(primary.url);
  if (robotsUrl) {
    const res = await deps.fetchRobots(robotsUrl).catch(() => null);
    if (res && robotsUnavailableMeansStop(res.status)) {
      // RFC 9309 §2.3.1.4 — a 5xx means assume disallow. Stopping here is the
      // conservative read and costs us one submission's enrichment, not data.
      rules = denyAll();
      robotsState = "unavailable-stop";
    } else if (res && res.status >= 200 && res.status < 300 && res.body.trim()) {
      rules = parseRobots(res.body, deps.userAgent ?? CRAWL_USER_AGENT);
      robotsState = "allowed";
    } else {
      // 404 / empty — RFC 9309 §2.3.1.3: no restrictions.
      robotsState = "none";
    }
  }
  if (robotsState === "unavailable-stop") {
    const blocked = emptyEnrichment("unavailable-stop");
    blocked.pages = targets.map((t) => ({
      url: t.url,
      anchorText: t.anchorText,
      hintClass: t.hintClass,
      finalClass: null,
      outcome: "robots-disallowed" as const,
      producedFields: [],
      rosterCount: 0,
      textChars: 0,
      offSiteTicketHop: false,
    }));
    blocked.elapsedMs = Date.now() - startedAt;
    return blocked;
  }

  const delayMs = effectiveCrawlDelayMs(rules.crawlDelaySeconds);

  const pages: CrawledPageRecord[] = [];
  const rosterNames: string[] = [];
  const rosterSeen = new Set<string>();
  let ticketUrl: string | null = null;
  let ticketPriceMin: number | null = null;
  let ticketPriceMax: number | null = null;
  let priceSource: CrawlFieldSource | null = null;
  let fetchCount = 0;
  let textCharsFetched = 0;
  let anyDisallowed = false;
  /** The one off-site hop, spent at most once per submission. */
  let ticketHopUsed = false;

  const consider = async (
    target: { url: string; anchorText: string; hintClass: PageClass },
    offSite: boolean
  ): Promise<CrawlFetchResult | null> => {
    let path = "/";
    try {
      const u = new URL(target.url);
      path = `${u.pathname}${u.search}`;
    } catch {
      /* fall through with "/" */
    }
    // robots applies to the primary host; the off-site ticket hop is a single
    // link the organizer themselves published as their purchase button.
    if (!offSite && !rules.isAllowed(path)) {
      anyDisallowed = true;
      pages.push({
        url: target.url,
        anchorText: target.anchorText,
        hintClass: target.hintClass,
        finalClass: null,
        outcome: "robots-disallowed",
        producedFields: [],
        rosterCount: 0,
        textChars: 0,
        offSiteTicketHop: offSite,
      });
      return null;
    }

    if (fetchCount > 0) await deps.wait(delayMs);
    const fetched = await deps.fetchPage(target.url).catch(() => null);
    fetchCount++;
    if (!fetched) {
      pages.push({
        url: target.url,
        anchorText: target.anchorText,
        hintClass: target.hintClass,
        finalClass: null,
        outcome: "fetch-failed",
        producedFields: [],
        rosterCount: 0,
        textChars: 0,
        offSiteTicketHop: offSite,
      });
      return null;
    }
    textCharsFetched += fetched.content.length;
    return fetched;
  };

  for (const target of targets) {
    const fetched = await consider(target, false);
    if (!fetched) continue;

    const finalClass = classifyPage({
      hintClass: target.hintClass,
      heading: headingOf(fetched),
      title: fetched.title,
    });

    const producedFields: string[] = [];
    let rosterCount = 0;

    if (finalClass === "vendors") {
      const names = extractInlineRoster(fetched.content);
      for (const n of names) {
        const key = n.toLowerCase();
        if (rosterSeen.has(key)) continue;
        rosterSeen.add(key);
        rosterNames.push(n);
      }
      rosterCount = names.length;
      if (names.length > 0) producedFields.push("roster");
    }

    if (finalClass === "tickets") {
      const onPage = parseAdmissionPrices(fetched.content);
      if (onPage.min !== null && ticketPriceMin === null) {
        ticketPriceMin = onPage.min;
        ticketPriceMax = onPage.max;
        priceSource = {
          url: fetched.url,
          title: fetched.title,
          text: fetched.content,
          fetchedAt: new Date(),
        };
        producedFields.push("ticketPriceMin", "ticketPriceMax");
      }

      // The single off-site hop. Small-festival "Tickets" pages are prose plus
      // a button: the specimen's own is 1,813 characters with ZERO prices,
      // every one of them on the ticketing vendor's form. Without this hop the
      // price is not merely missed, it is unreachable on this shape of site.
      const hop = selectTicketVendorLink(fetched.links as DiscoveredLink[], fetched.url);
      if (hop && !ticketHopUsed) {
        ticketHopUsed = true;
        // The real purchase URL, which beats the homepage we would otherwise
        // have stored — recorded even if the fetch below fails.
        if (!ticketUrl) {
          ticketUrl = hop.url;
          producedFields.push("ticketUrl");
        }
        const vendorPage = await consider(
          { url: hop.url, anchorText: hop.text, hintClass: "tickets" },
          true
        );
        if (vendorPage) {
          const vendorPrices = parseAdmissionPrices(vendorPage.content);
          const fields: string[] = [];
          if (vendorPrices.min !== null && ticketPriceMin === null) {
            ticketPriceMin = vendorPrices.min;
            ticketPriceMax = vendorPrices.max;
            priceSource = {
              url: vendorPage.url,
              title: vendorPage.title,
              text: vendorPage.content,
              fetchedAt: new Date(),
            };
            fields.push("ticketPriceMin", "ticketPriceMax");
          }
          pages.push({
            url: vendorPage.url,
            anchorText: hop.text,
            hintClass: "tickets",
            finalClass: "tickets",
            outcome: fields.length > 0 ? "ok" : "no-fields",
            producedFields: fields,
            rosterCount: 0,
            textChars: vendorPage.content.length,
            offSiteTicketHop: true,
          });
        }
      }
    }

    pages.push({
      url: fetched.url,
      anchorText: target.anchorText,
      hintClass: target.hintClass,
      finalClass,
      outcome: producedFields.length > 0 ? "ok" : "no-fields",
      producedFields,
      rosterCount,
      textChars: fetched.content.length,
      offSiteTicketHop: false,
    });
  }

  return {
    ticketUrl,
    ticketPriceMin,
    ticketPriceMax,
    priceSource,
    rosterNames,
    pages,
    fetchCount,
    elapsedMs: Date.now() - startedAt,
    textCharsFetched,
    robots: anyDisallowed ? "partially-disallowed" : robotsState,
  };
}

/** Minimal shape of the event fields the crawl can fill. */
export interface CrawlFillableEvent {
  ticketUrl: string | null;
  ticketPriceMin: number | null;
  ticketPriceMax: number | null;
}

/**
 * Apply crawl enrichment to an extracted event, FILL-EMPTY-ONLY.
 *
 * The primary page is the authority: it is the page the submitter actually
 * sent us, and a secondary page may be last year's. So a field the primary
 * established is never overwritten — the crawl can only turn a null into a
 * value. Returns the names of the fields it filled, for the workflow record.
 *
 * `ticketUrl` gets one narrow exception, and it is deliberate: when the stored
 * value is the SITE ROOT, that is not a ticket URL, it is the homepage that
 * the extractor fell back to. A real purchase link found on the Tickets page
 * replaces it. Any other existing value stands.
 */
export function applyCrawlEnrichment(
  event: CrawlFillableEvent,
  enrichment: Pick<CrawlEnrichment, "ticketUrl" | "ticketPriceMin" | "ticketPriceMax">,
  primaryUrl?: string
): string[] {
  const filled: string[] = [];

  if (enrichment.ticketPriceMin !== null && event.ticketPriceMin === null) {
    event.ticketPriceMin = enrichment.ticketPriceMin;
    filled.push("ticketPriceMin");
  }
  if (enrichment.ticketPriceMax !== null && event.ticketPriceMax === null) {
    event.ticketPriceMax = enrichment.ticketPriceMax;
    filled.push("ticketPriceMax");
  }

  if (enrichment.ticketUrl) {
    const existing = event.ticketUrl;
    const existingIsSiteRoot = (() => {
      if (!existing) return false;
      try {
        const e = new URL(existing);
        const isRootPath = e.pathname === "/" && !e.search;
        if (!isRootPath) return false;
        if (!primaryUrl) return true;
        return new URL(primaryUrl).hostname === e.hostname;
      } catch {
        return false;
      }
    })();
    if (!existing || existingIsSiteRoot) {
      event.ticketUrl = enrichment.ticketUrl;
      filled.push("ticketUrl");
    }
  }

  return filled;
}
