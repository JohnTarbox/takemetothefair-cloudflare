/**
 * OPE-456 scope 4, as a generator — record click-milestone crossings as they
 * happen, from our own `gsc_daily_totals`.
 *
 * drizzle/0222 wrote nine derived crossings ONCE, on 2026-08-20. Nothing wrote
 * the next ones, so by 2026-09-16 the chart was missing 18K–21K and everything
 * past the 22K badge: the gap between Google's badges is exactly what the
 * derived rows were ruled in to fill (option 3 — plot both, distinguished by
 * `source`), and a one-shot backfill fills it only up to the day it ran.
 *
 * Three rules, each pinned by a test:
 *
 *  1. **Settled days only.** The daily GSC sync re-upserts [today-7, today-3]
 *     because Google revises recent days. A crossing derived from a day still
 *     inside that window can move, and a written row does not move with it. So
 *     only dates at or before today-{@link SETTLED_LAG_DAYS} count.
 *  2. **Never a second row for a threshold.** Any existing row for the
 *     threshold — a Google badge or an earlier derivation — suppresses this one.
 *     The unique index is keyed on `email_date`, so it cannot enforce this
 *     itself: a derived row dated differently from a badge would sit beside it.
 *  3. **Never a badge.** Rows are `source = derived_from_gsc_daily_totals`,
 *     `reached_date_source = derived`. Writing them as Google's would invent
 *     awards Google never made (it skipped 2K and 2.5K outright).
 */
import { and, eq, lte } from "drizzle-orm";
import { deriveCrossings, type Crossing } from "@takemetothefair/utils";
import { gscDailyTotals, gscMilestoneEmails } from "@/lib/db/schema";
import type { Db } from "@/lib/api/with-auth";

export const DERIVED_SOURCE = "derived_from_gsc_daily_totals";
export const DERIVED_DATE_SOURCE = "derived";
export const MILESTONE_SITE_URL = "https://meetmeatthefair.com/";
export const WINDOW_DAYS = 28;
/** The `error_logs.source` of the info row every run writes — the probe's evidence. */
export const DERIVE_LOG_SOURCE = "app/api/admin/analytics/gsc-milestones/derive";

/** The sync's incremental window starts at today-7; the day before it is settled. */
export const SETTLED_LAG_DAYS = 8;

/**
 * The thresholds the generator records. Below 1,000 the history is already
 * complete and predates the series' reach; above it, the step widens with scale
 * so the chart's label rail stays legible.
 */
export function milestoneLadder(): number[] {
  const out: number[] = [];
  for (let t = 1_000; t < 50_000; t += 1_000) out.push(t);
  for (let t = 50_000; t < 100_000; t += 5_000) out.push(t);
  for (let t = 100_000; t <= 1_000_000; t += 10_000) out.push(t);
  return out;
}

export interface DeriveRunResult {
  settledThrough: string;
  settledDays: number;
  inserted: Crossing[];
  /** Crossed thresholds skipped because a row already exists for them. */
  alreadyRecorded: number;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function recordDerivedMilestones(db: Db, now: Date): Promise<DeriveRunResult> {
  const settledThrough = isoDay(new Date(now.getTime() - SETTLED_LAG_DAYS * 86_400_000));

  const dailies = await db
    .select({
      siteUrl: gscDailyTotals.siteUrl,
      date: gscDailyTotals.date,
      clicks: gscDailyTotals.clicks,
    })
    .from(gscDailyTotals)
    .where(lte(gscDailyTotals.date, settledThrough));

  // Two properties' dailies summed together would double every total. The table
  // holds one today; refuse rather than guess which one the milestones mean.
  const sites = new Set(dailies.map((d) => d.siteUrl));
  if (sites.size > 1) {
    throw new Error(
      `gsc_daily_totals holds ${sites.size} properties (${[...sites].join(", ")}); refusing to sum across them`
    );
  }

  const recorded = await db
    .select({ threshold: gscMilestoneEmails.threshold })
    .from(gscMilestoneEmails)
    .where(
      and(eq(gscMilestoneEmails.metric, "clicks"), eq(gscMilestoneEmails.windowDays, WINDOW_DAYS))
    );
  const have = new Set(recorded.map((r) => r.threshold));

  const crossings = deriveCrossings(
    dailies.map((d) => ({ date: d.date, clicks: d.clicks })),
    milestoneLadder(),
    WINDOW_DAYS
  );
  const inserted = crossings.filter((c) => !have.has(c.threshold));

  if (inserted.length > 0) {
    const createdAt = now;
    // ~10 bound params per statement, far under D1's 100; one round trip.
    await db.batch(
      inserted.map((c) =>
        db
          .insert(gscMilestoneEmails)
          .values({
            metric: "clicks",
            windowDays: WINDOW_DAYS,
            threshold: c.threshold,
            reachedDate: c.reachedDate,
            reachedDateSource: DERIVED_DATE_SOURCE,
            // There is no email; the column is NOT NULL and orders the chart.
            emailDate: c.reachedDate,
            siteUrl: MILESTONE_SITE_URL,
            source: DERIVED_SOURCE,
            note: `OPE-456 — derived crossing (daily generator). 28d window total ${c.windowTotal}.`,
            createdAt,
          })
          .onConflictDoNothing()
      ) as unknown as Parameters<Db["batch"]>[0]
    );
  }

  return {
    settledThrough,
    settledDays: dailies.length,
    inserted,
    alreadyRecorded: crossings.length - inserted.length,
  };
}
