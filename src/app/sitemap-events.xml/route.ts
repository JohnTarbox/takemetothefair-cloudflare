import { and, count, gte, isNotNull } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { SITEMAP_MIN_COMPLETENESS } from "@/lib/completeness";
import { events } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import {
  SITEMAP_BASE_URL,
  safeLastMod,
  serializeUrlset,
  sitemapXmlHeaders,
  type SitemapUrl,
} from "@/lib/sitemap-xml";

export const runtime = "edge";

// /events listing paginates 30/page. Mirror that here so the sitemap's
// page-count matches the rendered page-count exactly. If the listing's
// page size changes, change it in both places (or extract a constant).
const EVENTS_PER_PAGE = 30;

async function buildEventUrls(): Promise<SitemapUrl[]> {
  const db = getCloudflareDb();
  const now = new Date();

  const [eventRows, futureCountRow, allCountRow] = await Promise.all([
    db
      .select({ slug: events.slug, updatedAt: events.updatedAt, endDate: events.endDate })
      .from(events)
      .where(
        and(
          isPublicEventStatus(),
          isNotNull(events.startDate),
          gte(events.completenessScore, SITEMAP_MIN_COMPLETENESS)
        )
      ),
    db
      .select({ count: count() })
      .from(events)
      // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate.
      .where(and(isPublicEventStatus(), isNotNull(events.startDate), upcomingEndPredicate(now))),
    db.select({ count: count() }).from(events).where(isPublicEventStatus()),
  ]);

  const detailPages: SitemapUrl[] = eventRows.map((event) => {
    const isPast = event.endDate && new Date(event.endDate) < now;
    return {
      url: `${SITEMAP_BASE_URL}/events/${event.slug}`,
      lastModified: safeLastMod(event.updatedAt),
      changeFrequency: isPast ? "monthly" : "weekly",
      priority: isPast ? 0.5 : 0.7,
    };
  });

  const paginationPages: SitemapUrl[] = [];
  const futureTotal = futureCountRow[0]?.count ?? 0;
  const futureTotalPages = Math.ceil(futureTotal / EVENTS_PER_PAGE);
  for (let page = 2; page <= futureTotalPages; page++) {
    paginationPages.push({
      url: `${SITEMAP_BASE_URL}/events?page=${page}`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    });
  }
  const allTotal = allCountRow[0]?.count ?? 0;
  const allTotalPages = Math.ceil(allTotal / EVENTS_PER_PAGE);
  for (let page = 2; page <= allTotalPages; page++) {
    paginationPages.push({
      url: `${SITEMAP_BASE_URL}/events/all?page=${page}`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.5,
    });
  }

  return [...paginationPages, ...detailPages];
}

export async function GET(): Promise<Response> {
  try {
    const urls = await buildEventUrls();
    return new Response(serializeUrlset(urls), {
      headers: sitemapXmlHeaders(3600),
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
