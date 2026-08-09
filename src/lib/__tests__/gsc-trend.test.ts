/**
 * A12 read surface — getGscTrend aggregation regression.
 *
 * In-memory better-sqlite3 harness (same pattern as gsc-sweep-pick-urls.test.ts).
 * Pins the bits most likely to break: daily grouping, query/page/date filters,
 * and especially the IMPRESSION-WEIGHTED position roll-up (a naive avg of the
 * per-row positions would be wrong).
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { getGscTrend } from "../gsc-trend";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const SCHEMA_SQL = `
  CREATE TABLE gsc_search_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    query TEXT NOT NULL,
    page TEXT NOT NULL,
    clicks INTEGER NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    ctr REAL NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
    updated_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE gsc_daily_totals (
    site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
    date TEXT NOT NULL,
    clicks INTEGER NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    ctr REAL NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_url, date)
  );
`;

const PAGE_A = "https://meetmeatthefair.com/events/a";
const PAGE_B = "https://meetmeatthefair.com/events/b";

let raw: InstanceType<typeof Database>;
let db: TestDb;

function seed(
  date: string,
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  position: number
) {
  raw
    .prepare(
      `INSERT INTO gsc_search_metrics (date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(date, query, page, clicks, impressions, position);
}

function seedTotal(date: string, clicks: number, impressions: number, position: number) {
  raw
    .prepare(
      `INSERT INTO gsc_daily_totals (date, clicks, impressions, position) VALUES (?, ?, ?, ?)`
    )
    .run(date, clicks, impressions, position);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });

  // Day 1: two (query,page) cells → day clicks=3, impr=100,
  //   weighted pos = (5*10 + 8*90)/100 = 7.7
  seed("2026-06-01", "fair", PAGE_A, 2, 10, 5.0);
  seed("2026-06-01", "fair", PAGE_B, 1, 90, 8.0);
  // Day 2: a different query, on page A.
  seed("2026-06-02", "festival", PAGE_A, 4, 20, 3.0);
  // Day 3: zero-click day (CTR must be 0, not NaN).
  seed("2026-06-03", "fair", PAGE_A, 0, 5, 12.0);

  // OPE-345 — property totals live in their own table and are DELIBERATELY
  // larger than the dimensioned rows above. That gap is the whole point: GSC
  // omits anonymized and long-tail rows from dimensioned responses, so the
  // property total genuinely exceeds the sum of the cells. Seeding them equal
  // would make a regression to the old summing behaviour invisible.
  seedTotal("2026-06-01", 9, 300, 7.7);
  seedTotal("2026-06-02", 12, 60, 3.0);
  seedTotal("2026-06-03", 1, 15, 12.0);
});

describe("getGscTrend — property level (OPE-345)", () => {
  it("reads gsc_daily_totals, NOT the sum of dimensioned rows", async () => {
    // The defect this pins: summing the dimensioned store gave 3,305 clicks for
    // July 2026 against Google's own 9,370 — a 64.7% undercount that no amount
    // of sync completeness fixes, because GSC never sends those rows.
    const { series, source } = await getGscTrend(db as never);
    expect(source).toBe("gsc_daily_totals");
    expect(series.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    expect(series[0]).toMatchObject({ clicks: 9, impressions: 300 }); // not 3/100
    expect(series[1]).toMatchObject({ clicks: 12, impressions: 60 }); // not 4/20
  });

  it("totals roll up the property table with impression-weighted position", async () => {
    const { totals } = await getGscTrend(db as never);
    // clicks 9+12+1=22, impr 300+60+15=375
    // weighted pos = (7.7*300 + 3*60 + 12*15)/375 = (2310+180+180)/375 = 7.12
    expect(totals).toMatchObject({ clicks: 22, impressions: 375, days: 3 });
    expect(totals.ctr).toBeCloseTo(22 / 375, 5);
    expect(totals.position).toBeCloseTo(7.12, 5);
  });

  it("yields 0 rather than NaN when a day has no impressions", async () => {
    raw.prepare(`DELETE FROM gsc_daily_totals`).run();
    seedTotal("2026-06-04", 0, 0, 0);
    const { series } = await getGscTrend(db as never);
    expect(series[0].ctr).toBe(0);
  });
});

describe("getGscTrend", () => {
  it("filters by exact query — still the dimensioned store, correctly", async () => {
    // Scoped to one query, the omitted rows are OTHER queries, so summing the
    // dimensioned table is right and the totals table cannot answer at all.
    const scoped = await getGscTrend(db as never, { query: "fair" });
    expect(scoped.source).toBe("gsc_search_metrics");
    const { series, totals } = scoped;
    expect(series.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-03"]);
    expect(totals.clicks).toBe(3); // festival's 4 clicks excluded
  });

  it("still computes impression-weighted position on the dimensioned path", async () => {
    // Kept from the pre-OPE-345 suite: scoped reads still sum (query,page)
    // cells, and a naive average of 5.0 and 8.0 (6.5) would be wrong — weighted
    // by impressions it is 7.7. Moving the property path off this table must not
    // quietly retire the check for the path that still uses it.
    const { series } = await getGscTrend(db as never, { query: "fair" });
    expect(series[0].position).toBeCloseTo(7.7, 5);
    expect(series[0].ctr).toBeCloseTo(0.03, 5); // 3 clicks / 100 impressions
  });

  it("filters by page as a path suffix of the stored full URL", async () => {
    const { series } = await getGscTrend(db as never, { page: "/events/a" });
    // PAGE_A appears on all three days; PAGE_B (day 1) is excluded.
    expect(series.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    expect(series[0]).toMatchObject({ clicks: 2, impressions: 10 }); // only the PAGE_A cell of day 1
  });

  it("filters by page as a full URL (exact)", async () => {
    const { series } = await getGscTrend(db as never, { page: PAGE_B });
    expect(series.map((p) => p.date)).toEqual(["2026-06-01"]);
    expect(series[0]).toMatchObject({ clicks: 1, impressions: 90 });
  });

  it("filters by an inclusive date window (property level)", async () => {
    const { series, source } = await getGscTrend(db as never, {
      startDate: "2026-06-02",
      endDate: "2026-06-02",
    });
    expect(source).toBe("gsc_daily_totals");
    expect(series.map((p) => p.date)).toEqual(["2026-06-02"]);
  });

  it("returns an empty series and zeroed totals when nothing matches", async () => {
    const { series, totals } = await getGscTrend(db as never, { query: "no-such-query" });
    expect(series).toEqual([]);
    expect(totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0, days: 0 });
  });

  it("echoes the applied filters", async () => {
    const { filters } = await getGscTrend(db as never, { query: "fair", startDate: "2026-06-01" });
    expect(filters).toEqual({
      query: "fair",
      page: null,
      startDate: "2026-06-01",
      endDate: null,
    });
  });
});
