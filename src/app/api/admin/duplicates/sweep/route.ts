/**
 * K2 part 6 (analyst, 2026-05-31) — dedup sweep + admin canary.
 *
 * Runs two GROUP BY queries over the events table looking for clusters
 * that occupy the same (place, date) bucket:
 *
 *   1. (venue_id, start_date) HAVING COUNT(*) > 1
 *      → strongest signal — same venue, same date. Almost always a
 *      genuine duplicate.
 *
 *   2. (venues.city, venues.state, events.start_date) HAVING COUNT(*) > 1
 *      → softer signal — same town + same date but maybe different
 *      venue rows (the Winthrop case before K3's merge tool). Useful
 *      for catching dups where two different venue records refer to
 *      the same physical place.
 *
 * Returns the clusters (max 100 per query) with enough context for an
 * operator to triage in the admin UI and decide which pair to
 * merge_events. Pairs with K3 (merge_events tool, #283) and K2 first
 * slice's dedup match key (#282) — the sweep is the regression
 * canary that proves K2 closes the duplicate-creation hole going
 * forward.
 *
 * Cron canary (daily Slack alert on growth in cluster count) is
 * DEFERRED to a follow-up PR — the mcp-server Worker hosts the cron
 * triggers per [[feedback_no_cron_triggers]], and adding one needs
 * coordination with the existing crons. The endpoint itself can be
 * polled today from the admin UI.
 *
 * Filtering:
 *   - status='APPROVED' only — DRAFT/PENDING/REJECTED rows shouldn't
 *     surface as 'duplicates' until they've actually been admitted.
 *   - REJECTED rows are explicitly excluded (these are merge
 *     tombstones from K3 / drizzle/0095).
 *   - Future: once K2 part 5 lands (drizzle/0096), exclude rows whose
 *     possible_duplicate_of IS NOT NULL — they're already flagged.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { sql, eq, and, isNotNull } from "drizzle-orm";
import { logError } from "@/lib/logger";

export const runtime = "edge";

interface VenueDateCluster {
  cluster_key: "venue_date";
  venue_id: string;
  start_date: string; // ISO
  count: number;
  event_ids: string[];
}

interface CityStateDateCluster {
  cluster_key: "city_state_date";
  city: string;
  state: string;
  start_date: string;
  count: number;
  event_ids: string[];
}

type Cluster = VenueDateCluster | CityStateDateCluster;

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getCloudflareDb();
    const limitParam = parseInt(request.nextUrl.searchParams.get("limit") || "100", 10);
    const limit = Math.max(1, Math.min(500, isNaN(limitParam) ? 100 : limitParam));

    // ── Query 1: (venue_id, start_date) clusters ──────────────────
    //
    // GROUP_CONCAT is SQLite's standard array-aggregator. We get a
    // comma-separated id list per cluster, split client-side. Filter
    // on count > 1 AND not REJECTED so tombstones from K3
    // (slug='*-merged-*', status='REJECTED') don't show up.
    const venueDateRows = await db
      .select({
        venueId: events.venueId,
        startDate: events.startDate,
        cnt: sql<number>`COUNT(*)`.as("cnt"),
        ids: sql<string>`GROUP_CONCAT(${events.id})`.as("ids"),
      })
      .from(events)
      .where(
        and(eq(events.status, "APPROVED"), isNotNull(events.venueId), isNotNull(events.startDate))
      )
      .groupBy(events.venueId, events.startDate)
      .having(sql`COUNT(*) > 1`)
      .limit(limit);

    const venueDateClusters: VenueDateCluster[] = venueDateRows.map((r) => ({
      cluster_key: "venue_date",
      venue_id: r.venueId as string,
      start_date: r.startDate?.toISOString() ?? "",
      count: r.cnt,
      event_ids: r.ids.split(","),
    }));

    // ── Query 2: (venues.city, venues.state, start_date) clusters ─
    //
    // INNER JOIN venues so we can group on city + state. Excludes
    // events without a venue and statewide events (no venue).
    const cityStateDateRows = await db
      .select({
        city: venues.city,
        state: venues.state,
        startDate: events.startDate,
        cnt: sql<number>`COUNT(*)`.as("cnt"),
        ids: sql<string>`GROUP_CONCAT(${events.id})`.as("ids"),
      })
      .from(events)
      .innerJoin(venues, eq(events.venueId, venues.id))
      .where(and(eq(events.status, "APPROVED"), isNotNull(events.startDate)))
      .groupBy(venues.city, venues.state, events.startDate)
      .having(sql`COUNT(*) > 1`)
      .limit(limit);

    const cityStateDateClusters: CityStateDateCluster[] = cityStateDateRows.map((r) => ({
      cluster_key: "city_state_date",
      city: r.city,
      state: r.state,
      start_date: r.startDate?.toISOString() ?? "",
      count: r.cnt,
      event_ids: r.ids.split(","),
    }));

    // Combine — city+state clusters that are SUBSETS of an existing
    // venue+date cluster are noise (they'd surface the same events
    // twice). Filter them.
    const venueDateEventIds = new Set(venueDateClusters.flatMap((c) => c.event_ids));
    const filteredCityStateClusters = cityStateDateClusters.filter(
      (c) => !c.event_ids.every((id) => venueDateEventIds.has(id))
    );

    const clusters: Cluster[] = [...venueDateClusters, ...filteredCityStateClusters];

    return NextResponse.json({
      success: true,
      counts: {
        venue_date_clusters: venueDateClusters.length,
        city_state_date_clusters: filteredCityStateClusters.length,
        total_clusters: clusters.length,
        // Useful headline metric for the (deferred) daily canary —
        // total APPROVED events involved in any cluster.
        events_in_clusters: new Set(clusters.flatMap((c) => c.event_ids)).size,
      },
      clusters,
      limit_applied: limit,
      // Operator hint: the next call after a sweep is usually
      // merge_events for each confirmed pair, in the order returned.
      next_action_hint:
        "For each genuine duplicate pair, call merge_events(keeper_event_id, duplicate_event_id). Confirmed-distinct pairs need no action — the sweep will surface them again next run, which is OK for now (a 'mark as not-a-duplicate' bypass is a future enhancement).",
    });
  } catch (error) {
    await logError(getCloudflareDb(), {
      message: "Dedup sweep route failure",
      error,
      source: "admin-duplicates-sweep",
      request,
      statusCode: 500,
    });
    return NextResponse.json(
      { success: false, error: "Failed to run dedup sweep" },
      { status: 500 }
    );
  }
}
