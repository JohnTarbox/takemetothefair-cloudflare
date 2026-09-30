export const dynamic = "force-dynamic";
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
 * Filtering (OPE-967 — see src/lib/duplicates/sweep-clusters.ts):
 *   - the PUBLIC set, via `publicEventWhere()` — APPROVED and TENTATIVE
 *     together. This used to read status='APPROVED' only, which could not see
 *     an APPROVED + TENTATIVE pair: both served publicly, invisible to the
 *     sweep (Brookfield Orchards Harvest Craft Fair, 2026-09-12).
 *   - REJECTED rows (merge tombstones from K3 / drizzle/0095), PENDING and
 *     DRAFT remain excluded, because the public predicate excludes them.
 *   - Future: once K2 part 5 lands (drizzle/0096), exclude rows whose
 *     possible_duplicate_of IS NOT NULL — they're already flagged.
 */

import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { findDuplicateClusters } from "@/lib/duplicates/sweep-clusters";

/**
 * Dual auth: admin session OR X-Internal-Key (via withAuthorized). The latter
 * lets the MCP Worker's dedup-sweep canary (A3, PR-6, 2026-06-01 EVE) poll this
 * read-only endpoint without an admin session. Same shape as the other
 * internal-cron-friendly admin routes (see backfill/source-domain etc).
 */

export const GET = withAuthorized(async ({ request, db }) => {
  try {
    const limitParam = parseInt(request.nextUrl.searchParams.get("limit") || "100", 10);
    const limit = Math.max(1, Math.min(500, isNaN(limitParam) ? 100 : limitParam));

    const { venueDateClusters, filteredCityStateClusters, clusters } = await findDuplicateClusters(
      db,
      limit
    );

    return NextResponse.json({
      success: true,
      counts: {
        venue_date_clusters: venueDateClusters.length,
        city_state_date_clusters: filteredCityStateClusters.length,
        total_clusters: clusters.length,
        // Useful headline metric for the (deferred) daily canary —
        // total publicly-served events involved in any cluster.
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
    await logError(db, {
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
});
