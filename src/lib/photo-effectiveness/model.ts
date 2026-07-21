/**
 * OPE-226 — photo-effectiveness scorecard: the pure model.
 *
 * I/O-free (mirrors `src/lib/photo-coverage/model.ts`, the OPE-225 rail it sits
 * on) so the snapshot, trend, lift and regression maths are unit-testable
 * without D1, GSC or GA4.
 *
 * ## The one idea this module exists to protect
 *
 * MMATF's highest-traffic pages are its imageless ones. So a cross-sectional
 * "pages with photos vs pages without" comparison is **confounded** — it would
 * report that imageless pages perform better and quietly argue against ever
 * adding a photo. Every number here is therefore either a WITHIN-PAGE
 * before/after against that page's own `image_set_at`, or a coverage/health
 * count that makes no causal claim at all.
 *
 * ## Absent is not zero
 *
 * The second rule, learned the expensive way one day before this shipped: an
 * entity type missing from the coverage table renders as 0/0, which on a
 * dashboard is indistinguishable from "we measured them and none have photos".
 * On 2026-07-21 that difference was 1,801 venues, promoters and performers.
 * So the snapshot writes rows ONLY for types actually observed, and every read
 * surfaces `unmeasuredTypes` explicitly rather than letting a gap render as a
 * healthy zero.
 */

import {
  DEMAND_TIERS,
  PHOTO_ENTITY_TYPES,
  type CoverageStateRow,
  type DemandTier,
  type PhotoEntityType,
} from "@/lib/photo-coverage/model";
import type { StaleRed } from "@/lib/cpi/stale-reds";
import { SITE_URL } from "@takemetothefair/constants";

/** Deep-link target for the scorecard's digest entries. */
export const PHOTO_SCORECARD_HREF = `${SITE_URL}/admin/analytics#photo-effectiveness`;

/** The before/after window, in days. 28d matches the OPE-225 demand window. */
export const LIFT_WINDOW_DAYS = 28;

/* ------------------------------------------------------------------ *
 * §1 + §4 — the daily snapshot
 * ------------------------------------------------------------------ */

/** One (date, entityType, tier) row of `photo_coverage_daily`. */
export interface SnapshotPoint {
  date: string; // YYYY-MM-DD
  entityType: PhotoEntityType;
  demandTier: DemandTier;
  total: number;
  withImage: number;
  hotlinked: number;
  unreachable: number;
  addedSinceBaseline: number;
  scanComplete: boolean;
}

export function coveragePct(withImage: number, total: number): number {
  return total === 0 ? 0 : Math.round((withImage / total) * 1000) / 10;
}

/**
 * Fold current coverage state into the rows to append for `date`.
 *
 * Emits all four tiers for every entity type that HAS observations, and no rows
 * at all for a type that has none. That asymmetry is deliberate and is the
 * whole point: a tier with zero entities inside a measured type is genuinely
 * empty, whereas a type with zero rows was never measured — and the only way to
 * keep those distinguishable downstream is for one to be a zero and the other
 * to be an absence.
 */
export function buildSnapshotRows(
  rows: CoverageStateRow[],
  date: string,
  scanComplete: boolean
): SnapshotPoint[] {
  const out: SnapshotPoint[] = [];

  for (const entityType of PHOTO_ENTITY_TYPES) {
    const mine = rows.filter((r) => r.entityType === entityType);
    if (mine.length === 0) continue; // never measured → absent, not zero

    for (const demandTier of DEMAND_TIERS) {
      const t = mine.filter((r) => r.demandTier === demandTier);
      out.push({
        date,
        entityType,
        demandTier,
        total: t.length,
        withImage: t.filter((r) => r.hasImage).length,
        hotlinked: t.filter((r) => r.urlHealth === "HOTLINKED").length,
        unreachable: t.filter((r) => r.urlHealth === "UNREACHABLE").length,
        addedSinceBaseline: t.filter((r) => r.imageSetAt != null).length,
        scanComplete,
      });
    }
  }

  return out;
}

/** Entity types with no rows on the newest date present in `points`. */
export function unmeasuredTypes(points: SnapshotPoint[]): PhotoEntityType[] {
  const latest = latestDate(points);
  if (latest == null) return [...PHOTO_ENTITY_TYPES];
  const seen = new Set(points.filter((p) => p.date === latest).map((p) => p.entityType));
  return PHOTO_ENTITY_TYPES.filter((t) => !seen.has(t));
}

export function latestDate(points: SnapshotPoint[]): string | null {
  let max: string | null = null;
  for (const p of points) if (max == null || p.date > max) max = p.date;
  return max;
}

export interface TierTrendPoint {
  date: string;
  total: number;
  withImage: number;
  coveragePct: number;
}

export interface TierTrend {
  tier: DemandTier;
  /** Oldest → newest. */
  series: TierTrendPoint[];
  /** Newest coverage minus the oldest in range, in percentage points. */
  deltaPp: number;
}

export interface EntityTrend {
  entityType: PhotoEntityType;
  total: number;
  withImage: number;
  coveragePct: number;
  hotlinked: number;
  unreachable: number;
  addedSinceBaseline: number;
  byTier: TierTrend[];
  /** Site-wide coverage delta for this type across the range, in pp. */
  deltaPp: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Roll the snapshot series into a per-entity-type trend.
 *
 * Only `scanComplete` rows feed the trend: a truncated scan produces real-looking
 * counts for the types it did reach, and letting those into a series would show
 * a coverage "cliff" that is an artefact of the scan dying, not of anything
 * changing on the site. Incomplete days are counted and reported separately.
 */
export function buildCoverageTrend(points: SnapshotPoint[]): EntityTrend[] {
  const usable = points.filter((p) => p.scanComplete);
  const dates = [...new Set(usable.map((p) => p.date))].sort();
  const newest = dates.at(-1) ?? null;

  const present = PHOTO_ENTITY_TYPES.filter((t) => usable.some((p) => p.entityType === t));

  return present.map((entityType) => {
    const mine = usable.filter((p) => p.entityType === entityType);
    const latest = mine.filter((p) => p.date === newest);

    const sum = (rows: SnapshotPoint[], k: keyof SnapshotPoint): number =>
      rows.reduce((a, r) => a + (r[k] as number), 0);

    const byTier: TierTrend[] = DEMAND_TIERS.map((tier) => {
      const series = dates
        .map((date) => {
          const cell = mine.filter((p) => p.date === date && p.demandTier === tier);
          if (cell.length === 0) return null;
          const total = sum(cell, "total");
          const withImage = sum(cell, "withImage");
          return { date, total, withImage, coveragePct: coveragePct(withImage, total) };
        })
        .filter((x): x is TierTrendPoint => x !== null);

      const first = series.at(0);
      const last = series.at(-1);
      return {
        tier,
        series,
        deltaPp: first && last ? round1(last.coveragePct - first.coveragePct) : 0,
      };
    });

    // Site-wide delta for the type: recomputed from totals at each end, never
    // averaged across tiers (an average of percentages weights a 4-row tier the
    // same as a 4,914-row one).
    const at = (date: string | null) => {
      const rows = date == null ? [] : mine.filter((p) => p.date === date);
      return rows.length === 0 ? null : coveragePct(sum(rows, "withImage"), sum(rows, "total"));
    };
    const firstPct = at(dates.at(0) ?? null);
    const lastPct = at(newest);

    return {
      entityType,
      total: sum(latest, "total"),
      withImage: sum(latest, "withImage"),
      coveragePct: coveragePct(sum(latest, "withImage"), sum(latest, "total")),
      hotlinked: sum(latest, "hotlinked"),
      unreachable: sum(latest, "unreachable"),
      addedSinceBaseline: sum(latest, "addedSinceBaseline"),
      byTier,
      deltaPp: firstPct != null && lastPct != null ? round1(lastPct - firstPct) : 0,
    };
  });
}

/* ------------------------------------------------------------------ *
 * §2 — within-page before/after lift
 * ------------------------------------------------------------------ */

export interface LiftWindowMetrics {
  clicks: number;
  impressions: number;
  /** clicks/impressions recomputed from the sums — never an average of CTRs. */
  ctr: number;
}

export function windowMetrics(clicks: number, impressions: number): LiftWindowMetrics {
  return {
    clicks,
    impressions,
    ctr: impressions === 0 ? 0 : Math.round((clicks / impressions) * 10000) / 10000,
  };
}

/** One page's before/after sums, already gathered from `gsc_search_metrics`. */
export interface PageWindowSums {
  entityType: PhotoEntityType;
  entityId: string;
  slug: string;
  url: string;
  imageSetAt: Date;
  before: LiftWindowMetrics;
  after: LiftWindowMetrics;
  /**
   * True when the full after-window has elapsed AND is covered by the GSC data
   * we hold. A half-elapsed window understates the after side by construction.
   */
  matured: boolean;
}

export interface LiftBlock {
  windowDays: number;
  /** Entities carrying a non-null `image_set_at` — the eligible population. */
  eligible: number;
  /** Of those, how many have a fully-elapsed after-window. */
  matured: number;
  /** Per-page detail for the matured set, biggest CTR move first. */
  pages: Array<Omit<PageWindowSums, "imageSetAt"> & { imageSetAt: string; ctrDeltaPp: number }>;
  /** Aggregate over matured pages only. Null when nothing has matured yet. */
  aggregate: {
    pages: number;
    before: LiftWindowMetrics;
    after: LiftWindowMetrics;
    ctrDeltaPp: number;
    clicksDelta: number;
    impressionsDelta: number;
  } | null;
  /** Plain-language statement of what this sample can and cannot support. */
  note: string;
}

function pp(ctrDelta: number): number {
  return Math.round(ctrDelta * 100 * 100) / 100; // ratio → percentage points, 2dp
}

/**
 * Aggregate within-page before/after into the reportable lift block.
 *
 * Only MATURED pages contribute to the aggregate — this is the OPE-77
 * "re-measure after acting, and only count it if the window actually closed"
 * rule. Counting an in-flight page would import a guaranteed downward bias into
 * the after side and make photos look worse the more recently they were added.
 *
 * The `note` is not decoration. A lift figure over a handful of pages is noise,
 * and the scorecard's job here is to gate an automation flywheel — so the sample
 * size travels with the number, in words, wherever it is rendered.
 */
export function aggregateLift(
  pages: PageWindowSums[],
  eligible: number,
  windowDays: number = LIFT_WINDOW_DAYS
): LiftBlock {
  const matured = pages.filter((p) => p.matured);

  const detail = matured
    .map((p) => ({
      entityType: p.entityType,
      entityId: p.entityId,
      slug: p.slug,
      url: p.url,
      imageSetAt: p.imageSetAt.toISOString(),
      before: p.before,
      after: p.after,
      matured: p.matured,
      ctrDeltaPp: pp(p.after.ctr - p.before.ctr),
    }))
    .sort((a, b) => Math.abs(b.ctrDeltaPp) - Math.abs(a.ctrDeltaPp));

  let aggregate: LiftBlock["aggregate"] = null;
  if (matured.length > 0) {
    const bClicks = matured.reduce((a, p) => a + p.before.clicks, 0);
    const bImpr = matured.reduce((a, p) => a + p.before.impressions, 0);
    const aClicks = matured.reduce((a, p) => a + p.after.clicks, 0);
    const aImpr = matured.reduce((a, p) => a + p.after.impressions, 0);
    const before = windowMetrics(bClicks, bImpr);
    const after = windowMetrics(aClicks, aImpr);
    aggregate = {
      pages: matured.length,
      before,
      after,
      ctrDeltaPp: pp(after.ctr - before.ctr),
      clicksDelta: aClicks - bClicks,
      impressionsDelta: aImpr - bImpr,
    };
  }

  return {
    windowDays,
    eligible,
    matured: matured.length,
    pages: detail,
    aggregate,
    note: liftNote(eligible, matured.length, windowDays),
  };
}

/**
 * State the sample honestly. Three genuinely different situations that a bare
 * "0" would collapse into one.
 */
export function liftNote(eligible: number, matured: number, windowDays: number): string {
  if (eligible === 0) {
    return (
      `No entity has gained an image since the coverage rail was installed, so there is ` +
      `nothing with a before/after boundary to measure yet. Pages that already had an ` +
      `image are baseline (image_set_at is NULL) and deliberately cannot carry a lift ` +
      `claim. This fills in as photos are added.`
    );
  }
  if (matured === 0) {
    return (
      `${eligible} page(s) have gained an image, but none has a full ${windowDays}-day ` +
      `after-window yet, so no lift is claimed. The first results are due ${windowDays} ` +
      `days after the earliest image was added.`
    );
  }
  if (matured < 10) {
    return (
      `Based on ${matured} matured page(s) of ${eligible} eligible — too few to support a ` +
      `directional conclusion. Treat as provisional and do not gate a rollout on it.`
    );
  }
  return `Based on ${matured} matured page(s) of ${eligible} eligible, ${windowDays}-day windows.`;
}

/* ------------------------------------------------------------------ *
 * Regressions → the OPE-75 operator digest
 * ------------------------------------------------------------------ */

/** Coverage drop, in percentage points, that counts as a regression. */
export const COVERAGE_REGRESSION_PP = 5;

export interface RegressionInput {
  points: SnapshotPoint[];
  /** Entity types the scorecard expected to see on the latest date. */
  expectedTypes?: readonly PhotoEntityType[];
}

/**
 * Turn scorecard state into stale-reds for the existing operator digest.
 *
 * The completeness red is the important one, and it is NOT redundant with the
 * OPE-225 `image-coverage-scan` heartbeat probe. That probe reads
 * `max(checked_at)` — and a truncated scan still stamps `checked_at` on every
 * row it DID write, so the probe reads fresh evidence and stays green while
 * two-thirds of the site goes unmeasured. A liveness probe cannot detect a
 * partial write; only a completeness assertion can.
 */
export function detectPhotoRegressions(input: RegressionInput, now: Date): StaleRed[] {
  const { points } = input;
  const expected = input.expectedTypes ?? PHOTO_ENTITY_TYPES;
  const latest = latestDate(points);
  if (latest == null) return [];

  const reds: StaleRed[] = [];
  const latestRows = points.filter((p) => p.date === latest);
  const stamp = new Date(`${latest}T00:00:00.000Z`);
  const hoursInRed = Math.max(0, (now.getTime() - stamp.getTime()) / 3_600_000);

  const missing = expected.filter((t) => !latestRows.some((p) => p.entityType === t));
  if (missing.length > 0) {
    reds.push({
      priority: "P1",
      title:
        `Photo coverage: ${missing.length} entity type(s) not measured — ` +
        `${missing.join(", ")}. Coverage numbers exclude them entirely.`,
      refKey: "photo-effectiveness:unmeasured-types",
      href: PHOTO_SCORECARD_HREF,
      firstDetectedAt: stamp.toISOString(),
      hoursInRed,
    });
  }

  if (latestRows.length > 0 && latestRows.every((p) => !p.scanComplete)) {
    reds.push({
      priority: "P1",
      title:
        `Photo coverage: latest scan (${latest}) reported INCOMPLETE — ` +
        `trend and coverage percentages are not trustworthy.`,
      refKey: "photo-effectiveness:scan-incomplete",
      href: PHOTO_SCORECARD_HREF,
      firstDetectedAt: stamp.toISOString(),
      hoursInRed,
    });
  }

  // Coverage regression, per entity type, across the complete-scan series.
  for (const trend of buildCoverageTrend(points)) {
    if (trend.deltaPp <= -COVERAGE_REGRESSION_PP) {
      reds.push({
        priority: "P1",
        title:
          `Photo coverage for ${trend.entityType} fell ${Math.abs(trend.deltaPp)}pp ` +
          `to ${trend.coveragePct}% over the reported window.`,
        refKey: `photo-effectiveness:coverage-drop:${trend.entityType}`,
        href: PHOTO_SCORECARD_HREF,
        firstDetectedAt: stamp.toISOString(),
        hoursInRed,
      });
    }
  }

  return reds;
}
