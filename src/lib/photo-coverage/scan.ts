/**
 * OPE-225 — the ONE writer of `image_coverage_state`.
 *
 * Reads the current image URL of every live entity, joins a rolling 28-day GSC
 * impression count for its canonical URL, and reconciles each observation onto
 * the stored row via the pure rules in ./model.
 *
 * Nothing else writes this table. See model.ts for why an observer beats
 * stamping `image_set_at` at ~108 image-write sites.
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { SITE_URL } from "@takemetothefair/constants";
import {
  events,
  gscSearchMetrics,
  imageCoverageState,
  performers,
  promoters,
  vendors,
  venues,
} from "@/lib/db/schema";
import {
  reconcileCoverageRow,
  type CoverageObservation,
  type CoverageStateRow,
  type PhotoEntityType,
} from "./model";

type Db = DrizzleD1Database<Record<string, unknown>>;

/**
 * D1 caps a statement at 100 bound parameters. `inArray(page, [...])` is the
 * only way to aggregate GSC rows per entity — a correlated LIKE join trips
 * D1's "LIKE pattern too complex" guard (see src/lib/admin/blog-coverage.ts:200).
 * 90 leaves headroom for the other bindings in the same statement.
 */
const GSC_PARAM_CHUNK = 90;

/** Rolling demand window. Matches the GSC 28-day default so numbers reconcile. */
export const DEMAND_WINDOW_DAYS = 28;

/** URL path segment per entity type — how a canonical URL is built. */
const PATH_SEGMENT: Record<PhotoEntityType, string> = {
  EVENT: "events",
  VENDOR: "vendors",
  VENUE: "venues",
  PROMOTER: "promoters",
  PERFORMER: "performers",
};

export function canonicalUrlFor(entityType: PhotoEntityType, slug: string): string {
  return `${SITE_URL}/${PATH_SEGMENT[entityType]}/${slug}`;
}

/** One live entity with its current primary image. */
interface EntityRow {
  entityType: PhotoEntityType;
  entityId: string;
  slug: string;
  imageUrl: string | null;
}

/**
 * Load every entity that should be measured.
 *
 * Scoping choices, each deliberate:
 *  - Events: APPROVED and not merged. A REJECTED or tombstoned event has no
 *    public page, so counting it would depress coverage against pages that
 *    cannot be fixed.
 *  - Vendors / performers: soft-deleted rows excluded for the same reason.
 *  - Promoters use `hero_image_url` and fall back to `logo_url`: either one
 *    renders on the page, so requiring the hero alone would over-report the gap.
 */
async function loadEntities(db: Db): Promise<EntityRow[]> {
  const [ev, ve, pr, vn, pf] = await Promise.all([
    db
      .select({ id: events.id, slug: events.slug, imageUrl: events.imageUrl })
      .from(events)
      .where(and(eq(events.status, "APPROVED"), isNull(events.mergedInto))),
    db.select({ id: venues.id, slug: venues.slug, imageUrl: venues.imageUrl }).from(venues),
    db
      .select({
        id: promoters.id,
        slug: promoters.slug,
        heroImageUrl: promoters.heroImageUrl,
        logoUrl: promoters.logoUrl,
      })
      .from(promoters),
    db
      .select({ id: vendors.id, slug: vendors.slug, imageUrl: vendors.logoUrl })
      .from(vendors)
      .where(isNull(vendors.deletedAt)),
    db
      .select({ id: performers.id, slug: performers.slug, imageUrl: performers.imageUrl })
      .from(performers)
      .where(isNull(performers.deletedAt)),
  ]);

  return [
    ...ev.map((r) => ({
      entityType: "EVENT" as const,
      entityId: r.id,
      slug: r.slug,
      imageUrl: r.imageUrl,
    })),
    ...vn.map((r) => ({
      entityType: "VENDOR" as const,
      entityId: r.id,
      slug: r.slug,
      imageUrl: r.imageUrl,
    })),
    ...ve.map((r) => ({
      entityType: "VENUE" as const,
      entityId: r.id,
      slug: r.slug,
      imageUrl: r.imageUrl,
    })),
    ...pr.map((r) => ({
      entityType: "PROMOTER" as const,
      entityId: r.id,
      slug: r.slug,
      // Either renders on the page; requiring the hero alone over-reports the gap.
      imageUrl: r.heroImageUrl ?? r.logoUrl,
    })),
    ...pf.map((r) => ({
      entityType: "PERFORMER" as const,
      entityId: r.id,
      slug: r.slug,
      imageUrl: r.imageUrl,
    })),
  ];
}

/**
 * Sum 28-day GSC impressions per canonical URL.
 *
 * Chunked `inArray` + SUM in SQL, grouped by page. Entities with no GSC row at
 * all simply don't appear in the map and default to 0 — which lands them in T4
 * ("no recorded demand"), not in a tier that implies they were measured.
 */
export async function loadDemandByUrl(
  db: Db,
  urls: string[],
  now: Date
): Promise<Map<string, number>> {
  const cutoff = new Date(now.getTime() - DEMAND_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const out = new Map<string, number>();

  for (let i = 0; i < urls.length; i += GSC_PARAM_CHUNK) {
    const batch = urls.slice(i, i + GSC_PARAM_CHUNK);
    const rows = await db
      .select({
        page: gscSearchMetrics.page,
        impressions: sql<number>`sum(${gscSearchMetrics.impressions})`,
      })
      .from(gscSearchMetrics)
      .where(and(inArray(gscSearchMetrics.page, batch), gte(gscSearchMetrics.date, cutoff)))
      .groupBy(gscSearchMetrics.page);

    for (const r of rows) out.set(r.page, Number(r.impressions) || 0);
  }
  return out;
}

export interface ScanResult {
  scanned: number;
  inserted: number;
  updated: number;
  newlyImaged: number;
  imageless: number;
  hotlinked: number;
}

/**
 * Refresh `image_coverage_state` for every live entity.
 *
 * Idempotent: running twice in a row changes nothing except `checked_at`, and
 * in particular never re-stamps `image_set_at` (model rule 3).
 */
export async function refreshImageCoverageState(
  db: Db,
  now: Date = new Date()
): Promise<ScanResult> {
  const entities = await loadEntities(db);
  const demand = await loadDemandByUrl(
    db,
    entities.map((e) => canonicalUrlFor(e.entityType, e.slug)),
    now
  );

  const priorRows = await db.select().from(imageCoverageState);
  const prior = new Map<string, CoverageStateRow>();
  for (const r of priorRows) {
    prior.set(`${r.entityType}:${r.entityId}`, {
      entityType: r.entityType as PhotoEntityType,
      entityId: r.entityId,
      hasImage: r.hasImage,
      imageUrl: r.imageUrl,
      urlHealth: r.urlHealth,
      imageSetAt: r.imageSetAt,
      baselineHadImage: r.baselineHadImage,
      firstSeenAt: r.firstSeenAt,
      demandImpressions: r.demandImpressions,
      demandTier: r.demandTier,
      checkedAt: r.checkedAt,
    });
  }

  const result: ScanResult = {
    scanned: entities.length,
    inserted: 0,
    updated: 0,
    newlyImaged: 0,
    imageless: 0,
    hotlinked: 0,
  };

  for (const e of entities) {
    const key = `${e.entityType}:${e.entityId}`;
    const before = prior.get(key) ?? null;
    const obs: CoverageObservation = {
      entityType: e.entityType,
      entityId: e.entityId,
      slug: e.slug,
      imageUrl: e.imageUrl,
      demandImpressions: demand.get(canonicalUrlFor(e.entityType, e.slug)) ?? 0,
    };
    const next = reconcileCoverageRow(before, obs, now);

    if (before == null) result.inserted += 1;
    else result.updated += 1;
    if (before != null && before.imageSetAt == null && next.imageSetAt != null) {
      result.newlyImaged += 1;
    }
    if (!next.hasImage) result.imageless += 1;
    if (next.urlHealth === "HOTLINKED") result.hotlinked += 1;

    await db
      .insert(imageCoverageState)
      .values({
        entityType: next.entityType,
        entityId: next.entityId,
        slug: e.slug,
        hasImage: next.hasImage,
        imageUrl: next.imageUrl,
        urlHealth: next.urlHealth,
        imageSetAt: next.imageSetAt,
        baselineHadImage: next.baselineHadImage,
        firstSeenAt: next.firstSeenAt,
        demandImpressions: next.demandImpressions,
        demandTier: next.demandTier,
        checkedAt: next.checkedAt,
      })
      .onConflictDoUpdate({
        target: [imageCoverageState.entityType, imageCoverageState.entityId],
        set: {
          slug: e.slug,
          hasImage: next.hasImage,
          imageUrl: next.imageUrl,
          urlHealth: next.urlHealth,
          imageSetAt: next.imageSetAt,
          demandImpressions: next.demandImpressions,
          demandTier: next.demandTier,
          checkedAt: next.checkedAt,
          // firstSeenAt and baselineHadImage are intentionally NOT updated —
          // they describe the entity's state when the rail first saw it and
          // must stay immutable for the before/after boundary to mean anything.
        },
      });
  }

  return result;
}
