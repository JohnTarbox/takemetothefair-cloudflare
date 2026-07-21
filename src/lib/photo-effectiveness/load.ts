/**
 * OPE-226 — the D1 side of the photo-effectiveness scorecard.
 *
 * Split from ./model so every judgement (what counts as measured, what counts
 * as matured, what counts as a regression) stays pure and testable, and this
 * file only moves rows.
 *
 * Reads: `image_coverage_state` (OPE-225), `photo_coverage_daily` (this PR),
 * `gsc_search_metrics`. Writes: `photo_coverage_daily`, once per scan.
 */
import { and, desc, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { chunkIds } from "@takemetothefair/utils";
import { imageCoverageState, photoCoverageDaily, gscSearchMetrics } from "@/lib/db/schema";
import { canonicalUrlFor } from "@/lib/photo-coverage/scan";
import type { CoverageStateRow, PhotoEntityType } from "@/lib/photo-coverage/model";
import {
  LIFT_WINDOW_DAYS,
  aggregateLift,
  buildCoverageTrend,
  buildSnapshotRows,
  detectPhotoRegressions,
  latestDate,
  unmeasuredTypes,
  windowMetrics,
  type EntityTrend,
  type LiftBlock,
  type PageWindowSums,
  type SnapshotPoint,
} from "./model";

type Db = DrizzleD1Database<Record<string, unknown>>;

/** D1's 100-bound-param statement cap, with headroom (see scan.ts). */
const GSC_PARAM_CHUNK = 90;

/** Statements per `db.batch()` — same reasoning as the OPE-225 scan writer. */
const WRITE_BATCH_SIZE = 100;

/** Trend window for the scorecard's series. */
export const TREND_WINDOW_DAYS = 90;

/**
 * Cap on the lift population per run. The eligible set is currently 0 and grows
 * only as photos are added, but an unbounded `inArray` over it would eventually
 * trip D1's param cap in a way that fails at the worst time — when the feature
 * finally has data. Highest-demand pages first, so the cap never hides the
 * pages the scorecard exists to justify.
 */
export const MAX_LIFT_PAGES = 300;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Read the full current coverage state (the scan's own output). */
export async function loadCoverageState(db: Db): Promise<CoverageStateRow[]> {
  const rows = await db.select().from(imageCoverageState);
  return rows.map((r) => ({
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
    urlCheckedAt: r.urlCheckedAt,
    urlStatusCode: r.urlStatusCode,
  }));
}

/**
 * Append today's coverage snapshot. Idempotent — re-running on the same UTC day
 * upserts in place rather than forking a second row, so a scan retry after a
 * partial failure corrects the day instead of double-counting it.
 *
 * Called by the photo-coverage scan route AFTER the state write, and called
 * even when that scan was incomplete: the `scanComplete` flag travels with the
 * numbers so the trend can exclude them, and a missing day would look like an
 * unchanged metric rather than a broken pipeline.
 */
export async function persistPhotoCoverageSnapshot(
  db: Db,
  rows: CoverageStateRow[],
  scanComplete: boolean,
  now: Date = new Date()
): Promise<{ date: string; written: number }> {
  const date = ymd(now);
  const points = buildSnapshotRows(rows, date, scanComplete);
  if (points.length === 0) return { date, written: 0 };

  for (const chunk of chunkIds(points, WRITE_BATCH_SIZE)) {
    const statements = chunk.map((p) =>
      db
        .insert(photoCoverageDaily)
        .values({
          date: p.date,
          entityType: p.entityType,
          demandTier: p.demandTier,
          total: p.total,
          withImage: p.withImage,
          hotlinked: p.hotlinked,
          unreachable: p.unreachable,
          addedSinceBaseline: p.addedSinceBaseline,
          scanComplete: p.scanComplete,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            photoCoverageDaily.date,
            photoCoverageDaily.entityType,
            photoCoverageDaily.demandTier,
          ],
          set: {
            total: p.total,
            withImage: p.withImage,
            hotlinked: p.hotlinked,
            unreachable: p.unreachable,
            addedSinceBaseline: p.addedSinceBaseline,
            scanComplete: p.scanComplete,
            updatedAt: now,
          },
        })
    );
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  }

  return { date, written: points.length };
}

/** Read the snapshot series for the trend window. */
export async function loadSnapshotPoints(
  db: Db,
  days: number = TREND_WINDOW_DAYS,
  now: Date = new Date()
): Promise<SnapshotPoint[]> {
  const cutoff = ymd(addDays(now, -days));
  const rows = await db
    .select()
    .from(photoCoverageDaily)
    .where(gte(photoCoverageDaily.date, cutoff))
    .orderBy(photoCoverageDaily.date);

  return rows.map((r) => ({
    date: r.date,
    entityType: r.entityType as PhotoEntityType,
    demandTier: r.demandTier,
    total: r.total,
    withImage: r.withImage,
    hotlinked: r.hotlinked,
    unreachable: r.unreachable,
    addedSinceBaseline: r.addedSinceBaseline,
    scanComplete: r.scanComplete,
  }));
}

/** Newest GSC reporting day we actually hold. Bounds "matured". */
export async function loadGscMaxDate(db: Db): Promise<string | null> {
  const [r] = await db
    .select({ d: sql<string | null>`max(${gscSearchMetrics.date})` })
    .from(gscSearchMetrics);
  return r?.d ?? null;
}

/**
 * Gather within-page before/after sums for every entity that gained an image.
 *
 * Windows are per page, anchored on that page's own `image_set_at`:
 *   before = [set - windowDays, set - 1]   after = [set, set + windowDays - 1]
 *
 * `matured` requires the after-window to END on or before the newest GSC day we
 * hold. GSC also lags ~3 days, so "the window has elapsed in wall-clock time"
 * is not the same as "we have the data for it" — using wall-clock here would
 * silently score every recent page against a partially-populated after window
 * and bias the whole result downward.
 */
export async function loadPageWindowSums(
  db: Db,
  opts: { windowDays?: number; limit?: number } = {}
): Promise<{ pages: PageWindowSums[]; eligible: number }> {
  const windowDays = opts.windowDays ?? LIFT_WINDOW_DAYS;
  const limit = opts.limit ?? MAX_LIFT_PAGES;

  const eligibleRows = await db
    .select({
      entityType: imageCoverageState.entityType,
      entityId: imageCoverageState.entityId,
      slug: imageCoverageState.slug,
      imageSetAt: imageCoverageState.imageSetAt,
      demandImpressions: imageCoverageState.demandImpressions,
    })
    .from(imageCoverageState)
    .where(isNotNull(imageCoverageState.imageSetAt))
    .orderBy(desc(imageCoverageState.demandImpressions))
    .limit(limit);

  const [{ n: eligibleCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(imageCoverageState)
    .where(isNotNull(imageCoverageState.imageSetAt));

  if (eligibleRows.length === 0) {
    return { pages: [], eligible: Number(eligibleCount) || 0 };
  }

  const gscMax = await loadGscMaxDate(db);

  const specs = eligibleRows
    .filter((r) => r.imageSetAt != null)
    .map((r) => {
      const setAt = r.imageSetAt as Date;
      const url = canonicalUrlFor(r.entityType as PhotoEntityType, r.slug);
      return {
        entityType: r.entityType as PhotoEntityType,
        entityId: r.entityId,
        slug: r.slug,
        url,
        imageSetAt: setAt,
        beforeFrom: ymd(addDays(setAt, -windowDays)),
        beforeTo: ymd(addDays(setAt, -1)),
        afterFrom: ymd(setAt),
        afterTo: ymd(addDays(setAt, windowDays - 1)),
      };
    });

  // Belt-and-braces: `isNotNull` in the query already guarantees this, but the
  // reduce below seeds from specs[0] and an empty array would throw here rather
  // than at the query. A scorecard must never 500 because nothing has happened yet.
  if (specs.length === 0) return { pages: [], eligible: Number(eligibleCount) || 0 };

  // One pass over the metric rows for all pages, then bucket in memory. A
  // per-page pair of queries would be 2N round trips for no extra precision.
  const urls = specs.map((s) => s.url);
  const oldest = specs.reduce((a, s) => (s.beforeFrom < a ? s.beforeFrom : a), specs[0].beforeFrom);

  type MetricRow = { page: string; date: string; clicks: number; impressions: number };
  const metrics: MetricRow[] = [];
  for (const batch of chunkIds(urls, GSC_PARAM_CHUNK)) {
    const rows = await db
      .select({
        page: gscSearchMetrics.page,
        date: gscSearchMetrics.date,
        clicks: sql<number>`sum(${gscSearchMetrics.clicks})`,
        impressions: sql<number>`sum(${gscSearchMetrics.impressions})`,
      })
      .from(gscSearchMetrics)
      .where(and(inArray(gscSearchMetrics.page, batch), gte(gscSearchMetrics.date, oldest)))
      .groupBy(gscSearchMetrics.page, gscSearchMetrics.date);
    metrics.push(
      ...rows.map((r) => ({
        page: r.page,
        date: r.date,
        clicks: Number(r.clicks) || 0,
        impressions: Number(r.impressions) || 0,
      }))
    );
  }

  const byPage = new Map<string, MetricRow[]>();
  for (const m of metrics) {
    const list = byPage.get(m.page);
    if (list) list.push(m);
    else byPage.set(m.page, [m]);
  }

  const pages: PageWindowSums[] = specs.map((s) => {
    const rows = byPage.get(s.url) ?? [];
    const sum = (from: string, to: string) => {
      let clicks = 0;
      let impressions = 0;
      for (const r of rows) {
        if (r.date >= from && r.date <= to) {
          clicks += r.clicks;
          impressions += r.impressions;
        }
      }
      return windowMetrics(clicks, impressions);
    };
    return {
      entityType: s.entityType,
      entityId: s.entityId,
      slug: s.slug,
      url: s.url,
      imageSetAt: s.imageSetAt,
      before: sum(s.beforeFrom, s.beforeTo),
      after: sum(s.afterFrom, s.afterTo),
      matured: gscMax != null && s.afterTo <= gscMax,
    };
  });

  return { pages, eligible: Number(eligibleCount) || 0 };
}

export interface PhotoScorecard {
  generatedAt: string;
  latestSnapshotDate: string | null;
  scanComplete: boolean;
  /** Types absent from the newest snapshot — NOT measured, as against 0%. */
  unmeasuredTypes: PhotoEntityType[];
  /** Days in the trend window whose scan did not complete. */
  incompleteDays: number;
  trendWindowDays: number;
  coverage: EntityTrend[];
  lift: LiftBlock;
  /**
   * §3 — share of APPROVED events emitting an event-specific image in their
   * Event JSON-LD, as opposed to falling back to the generic og-default.
   */
  jsonLdImagePct: number;
  health: { hotlinked: number; unreachable: number; rotSweepHasRun: boolean };
}

/**
 * Assemble the whole scorecard. One call, so the digest, the MCP tool and the
 * admin panel all render the same numbers from the same read.
 */
export async function loadPhotoScorecard(
  db: Db,
  opts: { trendDays?: number; now?: Date } = {}
): Promise<PhotoScorecard> {
  const now = opts.now ?? new Date();
  const trendDays = opts.trendDays ?? TREND_WINDOW_DAYS;

  const points = await loadSnapshotPoints(db, trendDays, now);
  const { pages, eligible } = await loadPageWindowSums(db);

  const latest = latestDate(points);
  const latestRows = points.filter((p) => p.date === latest);
  const coverage = buildCoverageTrend(points);

  const incompleteDays = new Set(points.filter((p) => !p.scanComplete).map((p) => p.date)).size;

  const events = coverage.find((c) => c.entityType === "EVENT");

  const [rot] = await db
    .select({ n: sql<number>`count(*)` })
    .from(imageCoverageState)
    .where(isNotNull(imageCoverageState.urlCheckedAt));

  return {
    generatedAt: now.toISOString(),
    latestSnapshotDate: latest,
    scanComplete: latestRows.length > 0 && latestRows.every((p) => p.scanComplete),
    unmeasuredTypes: unmeasuredTypes(points),
    incompleteDays,
    trendWindowDays: trendDays,
    coverage,
    lift: aggregateLift(pages, eligible),
    // An event page emits its own image when it has one, and the generic
    // og-default otherwise — so this is exactly EVENT coverage, read from the
    // same snapshot rather than recomputed against a second source that could
    // drift from it.
    jsonLdImagePct: events?.coveragePct ?? 0,
    health: {
      hotlinked: coverage.reduce((a, c) => a + c.hotlinked, 0),
      unreachable: coverage.reduce((a, c) => a + c.unreachable, 0),
      // The rot sweep has produced zero evidence rows since OPE-225 shipped;
      // surfacing that here stops `unreachable: 0` reading as "nothing is
      // broken" when it actually means "nothing has been checked".
      rotSweepHasRun: Number(rot?.n ?? 0) > 0,
    },
  };
}

/** Stale-reds for the OPE-75 operator digest. Thin wrapper; logic is pure. */
export async function assessPhotoEffectiveness(db: Db, now: Date) {
  const points = await loadSnapshotPoints(db, TREND_WINDOW_DAYS, now);
  return detectPhotoRegressions({ points }, now);
}
