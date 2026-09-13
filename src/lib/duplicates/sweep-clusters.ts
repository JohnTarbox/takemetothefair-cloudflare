/**
 * OPE-967 — duplicate clusters across the set the PUBLIC is served.
 *
 * Extracted from `/api/admin/duplicates/sweep` so it can be tested against a
 * real database. The queries are unchanged except for one predicate: they
 * scoped on `status = 'APPROVED'`, and now use `publicEventWhere()` — the exact
 * predicate the public reader uses (status APPROVED or TENTATIVE, and a public
 * lifecycle).
 *
 * Why that one predicate is the whole fix: Brookfield Orchards Harvest Craft
 * Fair was listed twice on 2026-09-12 — same name, venue, dates and promoter,
 * one row APPROVED and one TENTATIVE, both on the public site. Every status-
 * scoped query is internally duplicate-free; the pair exists only in the UNION,
 * which is precisely the set visitors see and the one no audit asked about. An
 * audit that does not share the public predicate audits a different site.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { events, venues } from "@/lib/db/schema";
import { publicEventWhere } from "@/lib/event-lifecycle";
import type { getCloudflareDb } from "@/lib/cloudflare";

export interface VenueDateCluster {
  cluster_key: "venue_date";
  venue_id: string;
  start_date: string; // ISO
  count: number;
  event_ids: string[];
}

export interface CityStateDateCluster {
  cluster_key: "city_state_date";
  city: string;
  state: string;
  start_date: string;
  count: number;
  event_ids: string[];
}

export type Cluster = VenueDateCluster | CityStateDateCluster;

export async function findDuplicateClusters(db: ReturnType<typeof getCloudflareDb>, limit: number) {
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
    .where(and(publicEventWhere(), isNotNull(events.venueId), isNotNull(events.startDate)))
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
    .where(and(publicEventWhere(), isNotNull(events.startDate)))
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
  return { venueDateClusters, filteredCityStateClusters, clusters };
}
