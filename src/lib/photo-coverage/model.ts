/**
 * OPE-225 — photo-coverage rails: the pure model.
 *
 * Deliberately I/O-free (mirrors `src/lib/promoter-enrichment-dashboard.ts`,
 * the OPE-35 rail) so the classification, tiering, first-observation and
 * summary maths are unit-testable without D1 or a network.
 *
 * ## Why an OBSERVER, not 108 writers
 *
 * Scope §2 asks when an entity's image was first set, "dedicated column, or
 * derive reliably from admin_actions". A dedicated `image_set_at` column would
 * have to be stamped at ~108 distinct image-write sites across the main app and
 * the MCP Worker. Wiring a few and documenting the rest is how a rail ships 60%
 * done and then quietly under-reports forever — the failure mode this whole
 * ticket family exists to catch.
 *
 * So there is exactly ONE writer: a scan that observes current image state and
 * reconciles it into `image_coverage_state`. `imageSetAt` is stamped the first
 * time an entity is observed WITH an image having previously been observed
 * WITHOUT one, and is never overwritten.
 *
 * The honest trade-off, stated so nobody later mistakes this for wall-clock
 * truth: `imageSetAt` means "first observed with an image", granular to the
 * scan cadence — not the instant of the write. Entities that already had an
 * image when the rail was installed get `baselineHadImage = 1` and a NULL
 * `imageSetAt`, rather than a fabricated timestamp. That is precisely the
 * before/after boundary the OPE-226 scorecard needs: pre-existing images are
 * the baseline, and only images added after install can carry a lift claim.
 */

/** Entities that carry a primary image. Venues/promoters have no gallery table. */
export const PHOTO_ENTITY_TYPES = ["EVENT", "VENDOR", "VENUE", "PROMOTER", "PERFORMER"] as const;
export type PhotoEntityType = (typeof PHOTO_ENTITY_TYPES)[number];

/**
 * URL health (scope §4).
 *
 * `UNREACHABLE` is declared here but never produced by this module — proving a
 * URL rotted needs a live fetch, which belongs in the follow-up sweep. Naming
 * it now keeps the stored enum stable so the sweep doesn't require a migration.
 */
export const IMAGE_URL_HEALTH = ["MISSING", "OWNED", "HOTLINKED", "UNREACHABLE"] as const;
export type ImageUrlHealth = (typeof IMAGE_URL_HEALTH)[number];

/** Our own asset origins. Anything else is someone else's server. */
const OWNED_PREFIXES = [
  "https://cdn.meetmeatthefair.com/",
  "https://meetmeatthefair.com/",
  "/", // site-relative paths are served by us
];

/**
 * Classify a stored image URL.
 *
 * HOTLINKED matters because a third-party URL can vanish or be re-pointed
 * without warning — the audit counted 24 of them on events. It is a real
 * coverage risk even while the image still renders today.
 */
export function classifyImageUrlHealth(url: string | null | undefined): ImageUrlHealth {
  const u = (url ?? "").trim();
  if (!u) return "MISSING";
  if (OWNED_PREFIXES.some((p) => u.startsWith(p))) return "OWNED";
  return "HOTLINKED";
}

/** True when the entity has a usable image at all. */
export function hasImage(url: string | null | undefined): boolean {
  return classifyImageUrlHealth(url) !== "MISSING";
}

/**
 * Demand tiers (scope §1).
 *
 * The audit's headline was that the SIX highest-traffic events are imageless —
 * a flat coverage percentage hides that completely, which is why coverage is
 * sliced by tier rather than reported as one number.
 *
 * Thresholds are on 28-day GSC impressions, the only per-entity demand signal
 * we actually persist (`gsc_search_metrics` is per-page; GA4 per-page numbers
 * are live-API only and never stored). T4 therefore means "no search demand
 * recorded", which includes brand-new pages — not "worthless".
 */
export const DEMAND_TIERS = ["T1", "T2", "T3", "T4"] as const;
export type DemandTier = (typeof DEMAND_TIERS)[number];

export const DEMAND_TIER_MIN_IMPRESSIONS: Record<Exclude<DemandTier, "T4">, number> = {
  T1: 500,
  T2: 100,
  T3: 1,
};

export function demandTierFor(impressions: number): DemandTier {
  if (impressions >= DEMAND_TIER_MIN_IMPRESSIONS.T1) return "T1";
  if (impressions >= DEMAND_TIER_MIN_IMPRESSIONS.T2) return "T2";
  if (impressions >= DEMAND_TIER_MIN_IMPRESSIONS.T3) return "T3";
  return "T4";
}

/** A row as it exists in `image_coverage_state` before this scan. */
export interface CoverageStateRow {
  entityType: PhotoEntityType;
  entityId: string;
  hasImage: boolean;
  imageUrl: string | null;
  urlHealth: ImageUrlHealth;
  imageSetAt: Date | null;
  baselineHadImage: boolean;
  firstSeenAt: Date;
  demandImpressions: number;
  demandTier: DemandTier;
  checkedAt: Date;
}

/** What the scan observed for one entity right now. */
export interface CoverageObservation {
  entityType: PhotoEntityType;
  entityId: string;
  slug: string;
  imageUrl: string | null;
  demandImpressions: number;
}

/**
 * Fold one observation onto its prior state.
 *
 * The three rules that make `imageSetAt` trustworthy:
 *  1. **First ever sighting** (`prior == null`) is the BASELINE. If it already
 *     has an image we record `baselineHadImage` and leave `imageSetAt` NULL —
 *     we genuinely do not know when it was set, and inventing `now` would
 *     manufacture a lift window that never happened.
 *  2. **Gained an image** (had none, now has one) stamps `imageSetAt = now`.
 *  3. **Already stamped** never re-stamps — swapping one image for another is
 *     not a new before/after boundary, and re-stamping would silently reset any
 *     in-flight measurement.
 *
 * An entity that LOSES its image keeps its original `imageSetAt` (so the
 * history stays readable) but flips `hasImage` back to false, which re-enters
 * it into the demand-ranked queue.
 */
export function reconcileCoverageRow(
  prior: CoverageStateRow | null,
  obs: CoverageObservation,
  now: Date
): CoverageStateRow {
  const urlHealth = classifyImageUrlHealth(obs.imageUrl);
  const nowHasImage = urlHealth !== "MISSING";

  if (prior == null) {
    return {
      entityType: obs.entityType,
      entityId: obs.entityId,
      hasImage: nowHasImage,
      imageUrl: obs.imageUrl ?? null,
      urlHealth,
      imageSetAt: null, // rule 1 — baseline, not a measurable event
      baselineHadImage: nowHasImage,
      firstSeenAt: now,
      demandImpressions: obs.demandImpressions,
      demandTier: demandTierFor(obs.demandImpressions),
      checkedAt: now,
    };
  }

  const gainedImage = !prior.hasImage && nowHasImage;
  return {
    ...prior,
    hasImage: nowHasImage,
    imageUrl: obs.imageUrl ?? null,
    urlHealth,
    // rule 2 / rule 3
    imageSetAt: prior.imageSetAt ?? (gainedImage ? now : null),
    demandImpressions: obs.demandImpressions,
    demandTier: demandTierFor(obs.demandImpressions),
    checkedAt: now,
  };
}

export interface TierCoverage {
  tier: DemandTier;
  total: number;
  withImage: number;
  imageless: number;
  coveragePct: number;
}

export interface EntityCoverage {
  entityType: PhotoEntityType;
  total: number;
  withImage: number;
  imageless: number;
  coveragePct: number;
  hotlinked: number;
  byTier: TierCoverage[];
  /** Images observed to have been added since the rail was installed. */
  addedSinceBaseline: number;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

/**
 * Summarise stored state into the coverage metric (scope §1).
 *
 * Every tier is always present, including empty ones — a tier that silently
 * disappears from the payload reads as "fine" on a dashboard when it actually
 * means "not measured".
 */
export function summarizeCoverage(rows: CoverageStateRow[]): EntityCoverage[] {
  return PHOTO_ENTITY_TYPES.map((entityType) => {
    const mine = rows.filter((r) => r.entityType === entityType);
    const withImage = mine.filter((r) => r.hasImage).length;
    return {
      entityType,
      total: mine.length,
      withImage,
      imageless: mine.length - withImage,
      coveragePct: pct(withImage, mine.length),
      hotlinked: mine.filter((r) => r.urlHealth === "HOTLINKED").length,
      addedSinceBaseline: mine.filter((r) => r.imageSetAt != null).length,
      byTier: DEMAND_TIERS.map((tier) => {
        const t = mine.filter((r) => r.demandTier === tier);
        const tWith = t.filter((r) => r.hasImage).length;
        return {
          tier,
          total: t.length,
          withImage: tWith,
          imageless: t.length - tWith,
          coveragePct: pct(tWith, t.length),
        };
      }),
    };
  });
}

/**
 * The demand-ranked backlog (scope §3): imageless entities, highest search
 * demand first. Ranking only — sourcing images is OPE-227's job.
 *
 * Ties break on entityId so paging is stable across calls; an unstable sort
 * would let a row oscillate between pages and never get worked.
 */
export function rankImagelessByDemand(rows: CoverageStateRow[], limit: number): CoverageStateRow[] {
  return rows
    .filter((r) => !r.hasImage)
    .sort(
      (a, b) => b.demandImpressions - a.demandImpressions || a.entityId.localeCompare(b.entityId)
    )
    .slice(0, limit);
}
