import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, promoters, venues } from "@/lib/db/schema";
import { Ga4ApiError, Ga4ConfigError, getPageMetrics, type Ga4Env } from "@/lib/ga4";
import {
  getSearchQueriesForPage,
  ScApiError,
  ScConfigError,
  type ScEnv,
  type SearchQueryRow,
} from "@/lib/search-console";
import { DateRangeError, parseAnalyticsParams } from "@/lib/analytics-params";

export const runtime = "edge";

/**
 * GET /api/admin/analytics/event?eventId=X or ?slug=X
 * Looks up the event, derives its public path (/events/<slug>), then returns
 * GA4 page analytics + Search Console queries joined with the event record.
 * Auth: admin session OR X-Internal-Key header.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const eventId = url.searchParams.get("eventId");
  const slugParam = url.searchParams.get("slug");
  if (!eventId && !slugParam) {
    return NextResponse.json(
      {
        success: false,
        error: "bad_request",
        message: "Provide either 'eventId' or 'slug'.",
      },
      { status: 400 }
    );
  }

  const params = parseAnalyticsParams(url.searchParams);

  const db = getCloudflareDb();
  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      status: events.status,
      startDate: events.startDate,
      endDate: events.endDate,
      promoterId: events.promoterId,
      promoterName: promoters.companyName,
      venueId: events.venueId,
      venueName: venues.name,
      venueState: venues.state,
    })
    .from(events)
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(eventId ? eq(events.id, eventId) : eq(events.slug, slugParam!))
    .limit(1);

  const event = rows[0];
  if (!event) {
    return NextResponse.json(
      { success: false, error: "not_found", message: "Event not found." },
      { status: 404 }
    );
  }

  const path = `/events/${event.slug}`;

  try {
    const ga4Env = getCloudflareEnv() as unknown as Ga4Env;
    const scEnv = getCloudflareEnv() as unknown as ScEnv;

    const ga4Promise = getPageMetrics(ga4Env, path, {
      skipCache: params.refresh,
      dateRange: params.dateRange,
    });
    const scPromise = getSearchQueriesForPage(scEnv, path, {
      skipCache: params.refresh,
      dateRange: params.dateRange,
      rowLimit: params.rowLimit,
    }).catch((err) => {
      // Search Console is optional — if unconfigured, return empty rather than fail
      if (err instanceof ScConfigError || err instanceof ScApiError) {
        return [] as SearchQueryRow[];
      }
      throw err;
    });

    const [analytics, searchQueries] = await Promise.all([ga4Promise, scPromise]);

    return NextResponse.json({
      success: true,
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        status: event.status,
        path,
        startDate: event.startDate,
        endDate: event.endDate,
        promoter: event.promoterId ? { id: event.promoterId, name: event.promoterName } : null,
        venue: event.venueId
          ? { id: event.venueId, name: event.venueName, state: event.venueState }
          : null,
      },
      analytics,
      searchQueries,
    });
  } catch (error) {
    if (error instanceof DateRangeError) {
      return NextResponse.json(
        { success: false, error: "bad_request", message: error.message },
        { status: 400 }
      );
    }
    if (error instanceof Ga4ConfigError) {
      return NextResponse.json(
        { success: false, error: "config", message: error.message },
        { status: 503 }
      );
    }
    if (error instanceof Ga4ApiError) {
      return NextResponse.json(
        { success: false, error: "ga4_api", status: error.status, message: error.detail },
        { status: 502 }
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        { success: false, error: "timeout", message: "GA4 request timed out" },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}
