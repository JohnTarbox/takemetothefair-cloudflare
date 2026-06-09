import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, blogPosts } from "@/lib/db/schema";
import { and, gte, eq, sql, desc } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { withErrorHandler } from "@/lib/api-handler";
import { sanitizeLikeInput } from "@/lib/utils";
import { logError } from "@/lib/logger";

export const runtime = "edge";

// SEARCH1 (2026-06-09) — Cap query length at 100 chars. SQLite's LIKE-pattern
// complexity counter (limit ~50k) trips on long unanchored `%…%` patterns
// scanned against large text columns; before this cap, every keystroke past
// ~45 chars 500'd the whole route. The cap is enforced server-side and
// mirrored client-side as `maxLength` (defense in depth).
const MAX_QUERY_LENGTH = 100;

const EMPTY_RESPONSE = { events: [], venues: [], vendors: [], blogPosts: [] };

export const GET = withErrorHandler(async (request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  // Match the pre-existing `q.length < 2 → []` failure-closed convention.
  // Over-cap queries return empty rather than 4xx — there's no malicious
  // intent expected here, just a UX backstop. A scary banner mid-typing
  // would be worse than a temporarily-empty dropdown.
  if (!q || q.length < 2 || q.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(EMPTY_RESPONSE);
  }

  const db = getCloudflareDb();
  // Escape LIKE metacharacters (`%`, `_`) before wrapping the user's input.
  // Without this, a query like `100%_off` was interpreted as wildcards
  // rather than literal text.
  const searchTerm = `%${sanitizeLikeInput(q)}%`;

  // Promise.allSettled (not Promise.all) so one failing section returns
  // empty for that section instead of 500-ing the whole response. Each
  // per-section failure logs to D1 at `warn` so we keep visibility on the
  // (now-graceful) degradation; previously these manifested as hard 500s
  // in `error_logs` under source=`api/search`.
  const [eventsSettled, venuesSettled, vendorsSettled, blogSettled] = await Promise.allSettled([
    db
      .select({
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        venueName: venues.name,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(
        and(
          isPublicEventStatus(),
          gte(events.endDate, new Date()),
          sql`LOWER(${events.name}) LIKE LOWER(${searchTerm})`
        )
      )
      .orderBy(events.startDate)
      .limit(5),

    db
      .select({
        name: venues.name,
        slug: venues.slug,
        city: venues.city,
        state: venues.state,
      })
      .from(venues)
      .where(
        and(
          eq(venues.status, "ACTIVE"),
          sql`(LOWER(${venues.name}) LIKE LOWER(${searchTerm}) OR LOWER(${venues.city}) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(venues.name)
      .limit(5),

    db
      .select({
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
      })
      .from(vendors)
      .where(sql`LOWER(${vendors.businessName}) LIKE LOWER(${searchTerm})`)
      .orderBy(vendors.businessName)
      .limit(5),

    // SEARCH1 — Dropped `LOWER(blogPosts.body) LIKE …` from this WHERE.
    // The full-Markdown body column was the primary trigger for "LIKE
    // pattern too complex" failures on long queries. title + excerpt is
    // a smaller, denser search surface; FTS5 is the longer-term answer
    // (see plan §A "Out of scope") but a 1-line fix beats a migration.
    // COALESCE because some older posts have NULL excerpt.
    db
      .select({
        title: blogPosts.title,
        slug: blogPosts.slug,
        excerpt: blogPosts.excerpt,
      })
      .from(blogPosts)
      .where(
        and(
          eq(blogPosts.status, "PUBLISHED"),
          sql`(LOWER(${blogPosts.title}) LIKE LOWER(${searchTerm}) OR LOWER(COALESCE(${blogPosts.excerpt}, '')) LIKE LOWER(${searchTerm}))`
        )
      )
      .orderBy(desc(blogPosts.publishDate))
      .limit(5),
  ]);

  // Log per-section failures as `warn` (not `error`) — the route succeeded
  // overall and degraded gracefully. Real outages will show all 4 sections
  // failing simultaneously (operator can sum by section in /admin/logs).
  await Promise.all(
    (
      [
        [eventsSettled, "events"],
        [venuesSettled, "venues"],
        [vendorsSettled, "vendors"],
        [blogSettled, "blogPosts"],
      ] as const
    ).map(async ([settled, section]) => {
      if (settled.status === "rejected") {
        await logError(db, {
          message: `Search section "${section}" failed`,
          error: settled.reason,
          source: "api/search",
          request,
          context: { section, q },
          level: "warn",
        });
      }
    })
  );

  // Discriminated-union narrowing preserves the per-section query types
  // (the destructured `eventsSettled` is `PromiseSettledResult<T_events>`).
  const eventResults = eventsSettled.status === "fulfilled" ? eventsSettled.value : [];
  const venueResults = venuesSettled.status === "fulfilled" ? venuesSettled.value : [];
  const vendorResults = vendorsSettled.status === "fulfilled" ? vendorsSettled.value : [];
  const blogResults = blogSettled.status === "fulfilled" ? blogSettled.value : [];

  return NextResponse.json({
    events: eventResults.map((e) => ({
      name: e.name,
      slug: e.slug,
      startDate: e.startDate,
      endDate: e.endDate,
      venue: e.venueName ? { name: e.venueName, city: e.venueCity, state: e.venueState } : null,
    })),
    venues: venueResults,
    vendors: vendorResults,
    blogPosts: blogResults,
  });
}, "api/search");
