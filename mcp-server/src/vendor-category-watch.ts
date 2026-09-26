/**
 * OPE-1164 step 5 — a weekly watch on new vendor category values.
 *
 * `vendor_type` gained 595 new distinct values in June, 276 in July, 121 in
 * August and 72 in September (to the 25th): about one new vendor in twelve
 * arrives with a never-seen category, and no writer validates anything. There
 * is no controlled list yet (a separate decision for John), so the defence is
 * to SEE the vocabulary grow, week by week, with the values named.
 *
 * ── Mechanics ─────────────────────────────────────────────────────────────
 *
 * `vendor_category_values` remembers every (field, value) ever seen with the
 * day the watch first saw it. Each Monday run diffs the live distinct values
 * against it, records the new ones there, and writes one
 * `vendor_category_watch_runs` row per field — the new values themselves, the
 * threshold and whether it fired. A field's FIRST run is a baseline: everything
 * is recorded as `baseline` and nothing is reported as new.
 *
 * Thresholds are `tunable_thresholds` rows (alert when MORE than N new values):
 * `vendor_category_new_axis_max` (0) for the three new fields and
 * `vendor_category_new_vendor_type_max` (5) for `vendor_type`.
 *
 * The runs are read by the Monday inventory email (where John sees them) and
 * are plain D1 rows for the analyst lane. Guarded by the `vendor-category-watch`
 * heartbeat probe: a run writes a row per field even when nothing is new.
 */
import { eq, gte, sql } from "drizzle-orm";
import {
  tunableThresholds,
  vendorCategoryValues,
  vendorCategoryWatchRuns,
  vendors,
} from "./schema.js";
import type { Db } from "./db.js";

export const WATCH_FIELDS = [
  { field: "vendor_type", column: vendors.vendorType },
  { field: "sells_category", column: vendors.sellsCategory },
  { field: "business_sector", column: vendors.businessSector },
  { field: "vendor_identity", column: vendors.vendorIdentity },
] as const;
export type WatchField = (typeof WATCH_FIELDS)[number]["field"];

export const THRESHOLD_KEYS = {
  axis: "vendor_category_new_axis_max",
  vendorType: "vendor_category_new_vendor_type_max",
} as const;
export const DEFAULT_THRESHOLDS = { axis: 0, vendorType: 5 } as const;

const MONDAY = 1;
/** Rows per multi-row INSERT: 4 params each, well under D1's 100. */
const INSERT_CHUNK = 20;

export interface FieldWatchResult {
  field: WatchField;
  baseline: boolean;
  newValues: string[];
  threshold: number;
  fired: boolean;
}

async function readThresholds(db: Db): Promise<{ axis: number; vendorType: number }> {
  const rows = await db
    .select({ key: tunableThresholds.key, value: tunableThresholds.value })
    .from(tunableThresholds)
    .where(sql`${tunableThresholds.key} IN (${THRESHOLD_KEYS.axis}, ${THRESHOLD_KEYS.vendorType})`);
  const by = new Map(rows.map((r) => [r.key, r.value]));
  const pick = (k: string, d: number) => {
    const v = by.get(k);
    return typeof v === "number" && v >= 0 ? v : d;
  };
  return {
    axis: pick(THRESHOLD_KEYS.axis, DEFAULT_THRESHOLDS.axis),
    vendorType: pick(THRESHOLD_KEYS.vendorType, DEFAULT_THRESHOLDS.vendorType),
  };
}

/**
 * One watch pass over every field, ungated — the scheduled wrapper adds the
 * Monday gate. Exported so a test can force a run and see it fire.
 */
export async function watchVendorCategoriesOnce(
  db: Db,
  now: Date = new Date()
): Promise<FieldWatchResult[]> {
  const thresholds = await readThresholds(db);
  const results: FieldWatchResult[] = [];

  for (const { field, column } of WATCH_FIELDS) {
    const live = await db
      .selectDistinct({ v: sql<string>`trim(${column})` })
      .from(vendors)
      .where(sql`${column} IS NOT NULL AND trim(${column}) <> ''`);
    const known = await db
      .select({ value: vendorCategoryValues.value })
      .from(vendorCategoryValues)
      .where(eq(vendorCategoryValues.field, field));
    const knownSet = new Set(known.map((k) => k.value));
    const [priorRun] = await db
      .select({ id: vendorCategoryWatchRuns.id })
      .from(vendorCategoryWatchRuns)
      .where(eq(vendorCategoryWatchRuns.field, field))
      .limit(1);
    // A field with no prior run has no history to be "new" against.
    const baseline = !priorRun;

    const unseen = live
      .map((r) => r.v)
      .filter((v) => !knownSet.has(v))
      .sort();
    for (let i = 0; i < unseen.length; i += INSERT_CHUNK) {
      await db
        .insert(vendorCategoryValues)
        .values(
          unseen
            .slice(i, i + INSERT_CHUNK)
            .map((value) => ({ field, value, firstSeenAt: now, baseline }))
        )
        .onConflictDoNothing();
    }

    const newValues = baseline ? [] : unseen;
    const threshold = field === "vendor_type" ? thresholds.vendorType : thresholds.axis;
    const fired = newValues.length > threshold;
    await db.insert(vendorCategoryWatchRuns).values({
      runAt: now,
      field,
      newCount: newValues.length,
      newValues: JSON.stringify(newValues),
      threshold,
      fired,
    });
    results.push({ field, baseline, newValues, threshold, fired });
  }
  return results;
}

/** Monday only, once per Monday. Returns null when it did not run. */
export async function runVendorCategoryWatch(
  db: Db,
  now: Date = new Date()
): Promise<FieldWatchResult[] | null> {
  if (now.getUTCDay() !== MONDAY) return null;
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [already] = await db
    .select({ id: vendorCategoryWatchRuns.id })
    .from(vendorCategoryWatchRuns)
    .where(gte(vendorCategoryWatchRuns.runAt, dayStart))
    .limit(1);
  if (already) return null;
  return watchVendorCategoriesOnce(db, now);
}

/** The latest run's rows (one per field), for the Monday email. */
export async function readLatestWatch(db: Db): Promise<FieldWatchResult[]> {
  const [latest] = await db
    .select({ runAt: sql<number>`max(${vendorCategoryWatchRuns.runAt})` })
    .from(vendorCategoryWatchRuns);
  if (latest?.runAt == null) return [];
  const rows = await db
    .select()
    .from(vendorCategoryWatchRuns)
    .where(eq(vendorCategoryWatchRuns.runAt, new Date(Number(latest.runAt) * 1000)));
  return rows.map((r) => ({
    field: r.field as WatchField,
    baseline: false,
    newValues: JSON.parse(r.newValues) as string[],
    threshold: r.threshold,
    fired: r.fired,
  }));
}

/** Plain-text section for the Monday inventory. Values named, not just counted. */
export function formatWatchSection(results: FieldWatchResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r) => {
    const flag = r.fired ? "⚠️ " : "";
    const shown = r.newValues.slice(0, 15).join(", ");
    const more = r.newValues.length > 15 ? ` … +${r.newValues.length - 15} more` : "";
    return ` • ${flag}${r.field}: ${r.newValues.length} new (alert above ${r.threshold})${
      r.newValues.length ? ` — ${shown}${more}` : ""
    }`;
  });
  return `\n\nNew vendor category values this week (OPE-1164):\n${lines.join("\n")}`;
}

/** Cron entry point: never throws — a watch failure must not stop the inventory. */
export async function runScheduledVendorCategoryWatch(
  db: Db,
  log: (message: string, error: unknown) => Promise<void>
): Promise<void> {
  try {
    await runVendorCategoryWatch(db);
  } catch (error) {
    await log("[vendor-category-watch] run failed", error);
  }
}
