export const dynamic = "force-dynamic";
/**
 * DQ1 (2026-06-04) — venue + promoter dedup sweep, server-pollable.
 *
 * Mirrors `/api/admin/duplicates/sweep` (K2 part 6, events) but groups
 * VENUES and PROMOTERS themselves into clusters of likely-duplicate
 * rows. Surfaces the same shape the events sweep does so the admin
 * UI can render both with one template + a future daily canary cron
 * can poll a single shape across all entity types.
 *
 * Why a separate route from the existing `/api/admin/duplicates`
 * similarity-pair tool: that one is on-demand, threshold-tunable,
 * and 1:1-pair-shaped. This one is cluster-shaped (N>1 rows in the
 * same bucket) and server-polled — different consumer, different
 * normalization, different SLA.
 *
 * Match keys:
 *   - venues: `(normalize(name), city, state)` HAVING COUNT(*) > 1
 *     Catches "Beans & Greens Farm" vs "Beans and Greens Farm" (same
 *     city + state, names normalize the same way after `&`→`and` and
 *     lowercasing — the slug-divergence cohort).
 *   - promoters: `(normalize(companyName))` HAVING COUNT(*) > 1
 *     No city/state on promoters in the schema; name-only is the
 *     strongest signal. Catches "Craftah LLC" / "Craftah, LLC",
 *     "Saint Anthony's Feast" / "Saint Anthony's Society"
 *     (qualifier-suffix), "Yankee Homecoming" / "Yankee Homecoming
 *     Newburyport" (suffix-variant — only the first pair matches
 *     after the org-suffix strip; the third needs a different key).
 *
 * Normalization runs in SQL via a REPLACE chain so we don't fetch
 * every row client-side. Drops punctuation, lowercases, normalizes
 * `&`→`and`, collapses whitespace. Promoter side also strips common
 * organizational suffixes (` inc`, ` llc`, ` corp`, ` association`).
 *
 * Excludes:
 *   - venues.status='INACTIVE' (already soft-deleted)
 *   - promoters where companyName is null or empty
 *   - the system "Community Suggestions" promoter (intentional singleton)
 *
 * Out of scope (named-deferred): a `merge_venue` / `merge_promoter`
 * write tool. Today operators use `delete_venue` + manual event-id
 * reassign for venues; nothing similar for promoters yet. Building
 * the merge tools is the natural follow-up — they'd write
 * slug-history rows + transfer FK children identically to how
 * `merge_events` does for events.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { venues, promoters } from "@/lib/db/schema";
import { sql, and, eq, isNotNull, ne } from "drizzle-orm";
import { logError } from "@/lib/logger";

async function authorize(
  request: NextRequest,
  env: { INTERNAL_API_KEY?: string }
): Promise<boolean> {
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return true;
  }
  const session = await auth();
  return session?.user?.role === "ADMIN";
}

interface VenueCluster {
  cluster_key: "venue_name_city_state";
  normalized_name: string;
  city: string;
  state: string;
  count: number;
  venue_ids: string[];
  /** Display names of the duplicate rows for operator triage. */
  names: string[];
}

interface PromoterCluster {
  cluster_key: "promoter_name";
  normalized_name: string;
  count: number;
  promoter_ids: string[];
  names: string[];
}

type Cluster = VenueCluster | PromoterCluster;

export async function GET(request: NextRequest) {
  try {
    const env = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
    if (!(await authorize(request, env))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getCloudflareDb();
    const limitParam = parseInt(request.nextUrl.searchParams.get("limit") || "100", 10);
    const limit = Math.max(1, Math.min(500, isNaN(limitParam) ? 100 : limitParam));

    // ── Venue clusters: (normalized name, city, state) ────────────
    // The REPLACE chain handles the most common forms of the slug-
    // divergence cohort: `&` ↔ `and`, comma/period/apostrophe drops,
    // case-insensitivity, and double-space collapse.
    const venueNorm = sql<string>`TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${venues.name}), ',', ''), '.', ''), '''', ''), '&', 'and'), '-', ' '), '  ', ' '))`;
    const venueRows = await db
      .select({
        normalizedName: venueNorm.as("normalized_name"),
        city: venues.city,
        state: venues.state,
        cnt: sql<number>`COUNT(*)`.as("cnt"),
        ids: sql<string>`GROUP_CONCAT(${venues.id})`.as("ids"),
        names: sql<string>`GROUP_CONCAT(${venues.name}, ' | ')`.as("names"),
      })
      .from(venues)
      .where(and(eq(venues.status, "ACTIVE"), isNotNull(venues.city), isNotNull(venues.state)))
      .groupBy(venueNorm, venues.city, venues.state)
      .having(sql`COUNT(*) > 1`)
      .limit(limit);

    const venueClusters: VenueCluster[] = venueRows.map((r) => ({
      cluster_key: "venue_name_city_state",
      normalized_name: r.normalizedName,
      city: r.city,
      state: r.state,
      count: r.cnt,
      venue_ids: r.ids.split(","),
      names: r.names.split(" | "),
    }));

    // ── Promoter clusters: (normalized name with org-suffix strip) ─
    const promoterNorm = sql<string>`TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${promoters.companyName}), ',', ''), '.', ''), '''', ''), '&', 'and'), '-', ' '), '  ', ' '), ' inc', ''), ' llc', ''), ' corp', ''), ' association', ''))`;
    const promoterRows = await db
      .select({
        normalizedName: promoterNorm.as("normalized_name"),
        cnt: sql<number>`COUNT(*)`.as("cnt"),
        ids: sql<string>`GROUP_CONCAT(${promoters.id})`.as("ids"),
        names: sql<string>`GROUP_CONCAT(${promoters.companyName}, ' | ')`.as("names"),
      })
      .from(promoters)
      .where(
        and(
          isNotNull(promoters.companyName),
          ne(promoters.id, "system-community-suggestions"),
          sql`length(trim(${promoters.companyName})) > 0`
        )
      )
      .groupBy(promoterNorm)
      .having(sql`COUNT(*) > 1`)
      .limit(limit);

    const promoterClusters: PromoterCluster[] = promoterRows.map((r) => ({
      cluster_key: "promoter_name",
      normalized_name: r.normalizedName,
      count: r.cnt,
      promoter_ids: r.ids.split(","),
      names: r.names.split(" | "),
    }));

    return NextResponse.json({
      success: true,
      counts: {
        venue_clusters: venueClusters.length,
        promoter_clusters: promoterClusters.length,
        total_clusters: venueClusters.length + promoterClusters.length,
        venues_in_clusters: new Set(venueClusters.flatMap((c) => c.venue_ids)).size,
        promoters_in_clusters: new Set(promoterClusters.flatMap((c) => c.promoter_ids)).size,
      },
      clusters: [...venueClusters, ...promoterClusters] as Cluster[],
      limit_applied: limit,
      next_action_hint:
        "For each confirmed venue duplicate today: reassign event_id list manually then `delete_venue(loser_id)` (no merge_venue tool yet — named-deferred). Promoter merges require manual SQL pending a merge_promoter tool. The existing /admin/duplicates similarity-pair UI remains the on-demand triage path; this endpoint is the server-polled canary shape that mirrors the events sweep.",
    });
  } catch (error) {
    await logError(getCloudflareDb(), {
      message: "Entity dedup sweep route failure",
      error,
      source: "app/api/admin/duplicates/sweep-entities/route.ts:GET",
      request,
      statusCode: 500,
    });
    return NextResponse.json(
      { success: false, error: "Failed to run entity dedup sweep" },
      { status: 500 }
    );
  }
}
