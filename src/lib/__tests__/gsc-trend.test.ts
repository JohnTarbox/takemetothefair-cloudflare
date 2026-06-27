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
});

describe("getGscTrend", () => {
  it("returns a daily series ordered by date with summed clicks/impressions", async () => {
    const { series } = await getGscTrend(db as never);
    expect(series.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    expect(series[0]).toMatchObject({ clicks: 3, impressions: 100 });
    expect(series[1]).toMatchObject({ clicks: 4, impressions: 20 });
    expect(series[2]).toMatchObject({ clicks: 0, impressions: 5 });
  });

  it("computes impression-weighted average position (not a naive row average)", async () => {
    const { series } = await getGscTrend(db as never);
    // Naive avg of 5.0 and 8.0 would be 6.5; weighted by impressions it's 7.7.
    expect(series[0].position).toBeCloseTo(7.7, 5);
    expect(series[1].position).toBeCloseTo(3.0, 5);
  });

  it("computes per-day CTR and yields 0 (not NaN) on a zero-impression-safe path", async () => {
    const { series } = await getGscTrend(db as never);
    expect(series[0].ctr).toBeCloseTo(0.03, 5); // 3/100
    expect(series[2].ctr).toBe(0); // 0 clicks / 5 impressions
  });

  it("totals roll up the whole window with weighted position", async () => {
    const { totals } = await getGscTrend(db as never);
    // clicks 3+4+0=7, impr 100+20+5=125
    // weighted pos numerator = 7.7*100 + 3*20 + 12*5 = 770+60+60 = 890 → /125 = 7.12
    expect(totals).toMatchObject({ clicks: 7, impressions: 125, days: 3 });
    expect(totals.ctr).toBeCloseTo(7 / 125, 5);
    expect(totals.position).toBeCloseTo(7.12, 5);
  });

  it("filters by exact query", async () => {
    const { series, totals } = await getGscTrend(db as never, { query: "fair" });
    expect(series.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-03"]);
    expect(totals.clicks).toBe(3); // festival's 4 clicks excluded
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

  it("filters by an inclusive date window", async () => {
    const { series } = await getGscTrend(db as never, {
      startDate: "2026-06-02",
      endDate: "2026-06-02",
    });
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
