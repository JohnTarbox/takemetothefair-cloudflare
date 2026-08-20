export const dynamic = "force-dynamic";
import { getSitemapTypeLastMod } from "@/lib/sitemap-lastmod";
import { and, count, isNotNull } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import {
  getIndexableEventRows,
  canonicalEventPath,
  seriesLandingPath,
} from "@/lib/sitemap/indexable-events";
import { upcomingEndPredicate } from "@/lib/event-dates";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  conditionalXmlResponse,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";

// /events listing paginates 30/page. Mirror that here so the sitemap's
// page-count matches the rendered page-count exactly. If the listing's
// page size changes, change it in both places (or extract a constant).
const EVENTS_PER_PAGE = 30;

async function buildEventUrls(): Promise<SitemapUrl[]> {
  const db = getCloudflareDb();

  // OPE-333 follow-up — the listing pages' lastmod, and why it is NOT `new Date()`.
  //
  // The pagination entries used the render time, which made 84 of the 3,120
  // `<lastmod>` values change on EVERY request. Two consequences, and the
  // second is the expensive one:
  //
  //   1. The response body differed between identical requests, so the ETag
  //      differed too — `If-None-Match` could never match, and the ETag half
  //      of the conditional-GET work was dead on arrival for the whole file.
  //      (Verified against prod: four consecutive HEADs returned four ETags
  //      and one stable Last-Modified.)
  //   2. Every crawl was told those 84 listing pages had changed seconds ago.
  //      A lastmod that always says "now" carries no information, and Google
  //      discounts a lastmod it finds unreliable — so the cost is not just a
  //      wasted download, it is teaching the crawler to distrust the signal
  //      on the pages where it IS accurate.
  //
  // The listing pages change when their contents change, so the honest value
  // is the same MAX(updated_at) the index publishes for this type. Stable
  // across requests, and true.
  const listingLastMod = (await getSitemapTypeLastMod("events")) ?? new Date();

  // `now` is for TIME-OF-QUERY decisions only — is this event upcoming, is it
  // past. It must never become a `lastModified`; that conflation is the bug
  // above. Keeping the two named separately makes the next edit obvious.
  const now = new Date();

  const [eventRows, futureCountRow, allCountRow] = await Promise.all([
    // OPE-372 — the eligibility gate and the URL rule both live in
    // indexable-events.ts now, so the GSC inspection sweep asks Google about
    // exactly the URLs we publish here. When these were two queries they
    // diverged on URL shape, completeness threshold and start-date, and the
    // sweep spent months filing our own 301s as site-health defects.
    getIndexableEventRows(db),
    db
      .select({ count: count() })
      .from(events)
      // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate.
      .where(and(isPublicEventStatus(), isNotNull(events.startDate), upcomingEndPredicate(now))),
    db.select({ count: count() }).from(events).where(isPublicEventStatus()),
  ]);

  // Series landing URLs, deduped (one per series across its occurrences).
  const seriesLandings = new Map<string, Date | null>();

  const detailPages: SitemapUrl[] = eventRows.map((event) => {
    const isPast = event.endDate && new Date(event.endDate) < now;
    if (event.seriesSlug) {
      // Occurrence → canonical /events/<series>/<year>; collect its landing.
      // Landing lastModified = the most recent occurrence updatedAt.
      const prev = seriesLandings.get(event.seriesSlug) ?? null;
      seriesLandings.set(
        event.seriesSlug,
        event.updatedAt && (!prev || event.updatedAt > prev) ? event.updatedAt : prev
      );
      return {
        url: `${SITEMAP_BASE_URL}${canonicalEventPath(event)}`,
        lastModified: safeLastMod(event.updatedAt),
        changeFrequency: isPast ? "yearly" : "weekly",
        // Locked §8.3 — bias toward current/future occurrences.
        priority: isPast ? 0.4 : 0.8,
      };
    }
    // Standalone event → its own slug (today's behavior, unchanged).
    return {
      url: `${SITEMAP_BASE_URL}${canonicalEventPath(event)}`,
      lastModified: safeLastMod(event.updatedAt),
      changeFrequency: isPast ? "monthly" : "weekly",
      priority: isPast ? 0.5 : 0.7,
    };
  });

  // One landing entry per series that has ≥1 sitemap-eligible occurrence.
  const seriesPages: SitemapUrl[] = [...seriesLandings.entries()].map(([slug, lastMod]) => ({
    url: `${SITEMAP_BASE_URL}${seriesLandingPath(slug)}`,
    lastModified: safeLastMod(lastMod),
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  const paginationPages: SitemapUrl[] = [];
  const futureTotal = futureCountRow[0]?.count ?? 0;
  const futureTotalPages = Math.ceil(futureTotal / EVENTS_PER_PAGE);
  for (let page = 2; page <= futureTotalPages; page++) {
    paginationPages.push({
      url: `${SITEMAP_BASE_URL}/events?page=${page}`,
      lastModified: listingLastMod,
      changeFrequency: "daily",
      priority: 0.6,
    });
  }
  const allTotal = allCountRow[0]?.count ?? 0;
  const allTotalPages = Math.ceil(allTotal / EVENTS_PER_PAGE);
  for (let page = 2; page <= allTotalPages; page++) {
    paginationPages.push({
      url: `${SITEMAP_BASE_URL}/events/all?page=${page}`,
      lastModified: listingLastMod,
      changeFrequency: "weekly",
      priority: 0.5,
    });
  }

  return [...paginationPages, ...seriesPages, ...detailPages];
}

export async function GET(request: Request): Promise<Response> {
  try {
    const urls = await buildEventUrls();
    // OPE-333 — emit ETag + Last-Modified and honour a conditional GET, so an
    // unchanged sitemap costs a crawler a 304 instead of a full re-download.
    return await conditionalXmlResponse({
      request,
      body: serializeUrlset(urls),
      lastModified: await getSitemapTypeLastMod("events"),
    });
  } catch (error) {
    // Fail-soft: return an empty urlset rather than 500, so the index
    // stays healthy and crawlers see "no events right now" instead of an
    // HTTP error that might cause them to drop the whole sitemap.
    console.error("sitemap-events: D1 query failed", error);
    return new Response(serializeUrlset([]), {
      headers: sitemapXmlHeaders(60),
    });
  }
}
