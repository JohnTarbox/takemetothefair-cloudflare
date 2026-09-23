/**
 * OPE-1131 — the six-tab sweep: every tile that can be not-measured renders a
 * non-numeric state. Each case is driven TO the failure (fetch rejected, empty
 * denominator, capped sample, stopped feed) and asserts the tile text is not a
 * bare number.
 *
 * OPE-808 built `Measurement` and fixed four tiles; this covers the rest the
 * inventory found, plus two wrong-NUMBER bugs it turned up on the way (a double
 * ×100 and a tile still reading the deprecated sitemap field).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { measurementText, rateOverSample, sparklineTotal, ok, unavailable } from "../render-state";
import {
  bingWeekTotal,
  bingPagesIndexed,
  bingScanIssueCount,
  indexNowChip,
  indexNowCount,
} from "../bing-tiles";

const sc = vi.hoisted(() => ({
  getSiteSearchQueries: vi.fn(),
  getDailyClicks: vi.fn(),
}));
vi.mock("@/lib/search-console", async (orig) => ({
  ...(await orig<typeof import("@/lib/search-console")>()),
  getSiteSearchQueries: sc.getSiteSearchQueries,
  getDailyClicks: sc.getDailyClicks,
}));
const ga4 = vi.hoisted(() => ({ getOrganicSessions: vi.fn() }));
vi.mock("@/lib/ga4", async (orig) => ({
  ...(await orig<typeof import("@/lib/ga4")>()),
  getOrganicSessions: ga4.getOrganicSessions,
}));

import {
  loadSiteCtr,
  loadBrandVsNonBrand,
  loadSearchVisibilitySparkline,
} from "../search-visibility";
import { loadConversionRate } from "../conversions";
import { loadAccountEngagement } from "../activity";
import { ScApiError } from "@/lib/search-console";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const isBareNumber = (s: string) => /^[\d.,%+-]+$/.test(s.trim());

/** Drizzle chain stub: each awaited `.where()` resolves to the next result. */
function stubDb(results: Array<Array<{ n: number }>>) {
  let i = 0;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => Promise.resolve(results[i++] ?? [{ n: 0 }]);
  return chain as never;
}

function gscResult(clicks: number, impressions: number, returned: number, before?: number) {
  return {
    dateRange: { startDate: "x", endDate: "y" },
    queries: [
      { query: "meet me at the fair", clicks, impressions, ctr: 0, position: 1, topPages: [] },
    ],
    totals: { clicks, impressions, queries: returned, queriesBeforeLimit: before },
  };
}

beforeEach(() => {
  sc.getSiteSearchQueries.mockReset();
  sc.getDailyClicks.mockReset();
  ga4.getOrganicSessions.mockReset();
});

describe("measurementText — only `ok` prints a naked number", () => {
  it("renders each state with its cause", () => {
    expect(measurementText(ok(0.25), pct)).toBe("25.0%");
    expect(measurementText(unavailable("GA4 down"), pct)).toBe("— · GA4 down");
    expect(
      measurementText({ state: "undefined-rate", value: null, reason: "no clicks" }, pct)
    ).toBe("— · no clicks");
    expect(
      measurementText({ state: "truncated", value: 0.1, reason: "500 of 900 sampled" }, pct)
    ).toBe("10.0% · 500 of 900 sampled");
    expect(
      measurementText({ state: "stale", value: 4, reason: "feed closed 2026-08-11" }, String)
    ).toBe("🕒 4 · feed closed 2026-08-11");
  });
});

describe("Overview — CTR / brand share over a capped GSC sample", () => {
  it("0 impressions is an undefined rate, not 0%", async () => {
    sc.getSiteSearchQueries.mockResolvedValue(gscResult(0, 0, 0, 0));
    const c = await loadSiteCtr({} as never, 7);
    if (!c.ok) throw new Error("expected ok");
    expect(c.ctrMeasured.state).toBe("undefined-rate");
    expect(isBareNumber(measurementText(c.ctrMeasured, pct))).toBe(false);
  });

  it("a sample that hit the 500 cap is truncated and says so", async () => {
    sc.getSiteSearchQueries.mockResolvedValue(gscResult(10, 1000, 500, 1234));
    const c = await loadSiteCtr({} as never, 7);
    if (!c.ok) throw new Error("expected ok");
    expect(c.ctrMeasured.state).toBe("truncated");
    expect(measurementText(c.ctrMeasured, pct)).toMatch(/500 of 1,234 sampled/);
  });

  it("an uncapped sample is an ordinary reading — no false 'partial' badge", async () => {
    sc.getSiteSearchQueries.mockResolvedValue(gscResult(10, 1000, 120, 120));
    const c = await loadSiteCtr({} as never, 7);
    if (!c.ok) throw new Error("expected ok");
    expect(c.ctrMeasured.state).toBe("ok");
  });

  it("brand share over no clicks is undefined", async () => {
    sc.getSiteSearchQueries.mockResolvedValue(gscResult(0, 50, 1, 1));
    const b = await loadBrandVsNonBrand({} as never, 7);
    if (!b.ok) throw new Error("expected ok");
    expect(b.brandShareMeasured.state).toBe("undefined-rate");
  });
});

describe("Overview — rates with two different ways to be empty", () => {
  it("conversion rate: GA4 failure is unavailable; zero sessions is undefined", async () => {
    ga4.getOrganicSessions.mockResolvedValueOnce(null);
    const down = await loadConversionRate(stubDb([[{ n: 3 }]]), {} as never, 7);
    expect(down.rateMeasured.state).toBe("unavailable");
    expect(measurementText(down.rateMeasured, pct)).toMatch(/GA4/);

    ga4.getOrganicSessions.mockResolvedValueOnce(0);
    const empty = await loadConversionRate(stubDb([[{ n: 0 }]]), {} as never, 7);
    expect(empty.rateMeasured.state).toBe("undefined-rate");

    ga4.getOrganicSessions.mockResolvedValueOnce(200);
    const live = await loadConversionRate(stubDb([[{ n: 4 }]]), {} as never, 7);
    expect(live.rateMeasured).toEqual(ok(0.02));
  });

  it("account engagement over no first-party events is undefined, not 0%", async () => {
    const e = await loadAccountEngagement(
      stubDb([[{ n: 0 }], [{ n: 0 }], [{ n: 0 }], [{ n: 0 }]]),
      new Date(),
      7
    );
    expect(e.rateMeasured.state).toBe("undefined-rate");
    expect(isBareNumber(measurementText(e.rateMeasured, pct))).toBe(false);
  });
});

describe("Overview — sparklines", () => {
  it("a GSC failure is tagged, and the total is not '0'", async () => {
    sc.getDailyClicks.mockRejectedValue(new ScApiError(503, "backend"));
    const series = await loadSearchVisibilitySparkline({} as never);
    expect(series.unavailableReason).toMatch(/GSC unavailable/);
    expect(measurementText(sparklineTotal(series), String)).toMatch(/^— · GSC unavailable/);
  });

  it("publishing with no successful submission in the window is stale, not a plain 0", () => {
    const flat = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      value: 0,
    }));
    const m = sparklineTotal(flat, "indexnow_submissions", new Date("2026-09-30T12:00:00Z"));
    expect(m.state).toBe("stale");
    expect(measurementText(m, String)).toMatch(/no indexnow_submissions rows in 30 days/);
  });

  it("a live publishing series is ok", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const pts = [{ date: "2026-09-30", value: 3 }];
    expect(sparklineTotal(pts, "indexnow_submissions", now).state).toBe("ok");
  });
});

describe("Bing — a failed report is not a healthy one", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  it("traffic / crawl totals: failed → unavailable, empty → unavailable, old → stale", () => {
    expect(
      bingWeekTotal([], (r: { date: string; c: number }) => r.c, true, "bing_traffic", now).state
    ).toBe("unavailable");
    expect(
      bingWeekTotal([], (r: { date: string; c: number }) => r.c, false, "bing_traffic", now).state
    ).toBe("unavailable");
    const old = [{ date: "2026-08-01", c: 5 }];
    expect(bingWeekTotal(old, (r) => r.c, false, "bing_traffic", now).state).toBe("stale");
    const live = [{ date: "2026-09-21", c: 5 }];
    expect(bingWeekTotal(live, (r) => r.c, false, "bing_traffic", now)).toEqual(ok(5));
  });

  it("sums the NEWEST 7 rows whatever order Bing returns them in", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-09-${String(10 + i)}`,
      c: i,
    }));
    const shuffled = [...rows].reverse();
    expect(bingWeekTotal(shuffled, (r) => r.c, false, "bing_traffic", now).value).toBe(
      3 + 4 + 5 + 6 + 7 + 8 + 9
    );
  });

  it("pages indexed and scan issues say unavailable on failure", () => {
    expect(bingPagesIndexed([], true, now).state).toBe("unavailable");
    expect(bingScanIssueCount([], true).state).toBe("unavailable");
    expect(bingScanIssueCount([], false)).toEqual(ok(0)); // a MEASURED zero stays a zero
  });

  it("IndexNow: no KV is 'Unknown', not green 'Active'; a failed D1 read has no counts", () => {
    expect(
      indexNowChip({ kvAvailable: false, paused: false, breaker: { reason: null } }).label
    ).toBe("Unknown");
    expect(
      indexNowChip({ kvAvailable: true, paused: false, breaker: { reason: null } }).label
    ).toBe("Active");
    expect(indexNowCount(0, false).state).toBe("unavailable");
    expect(indexNowCount(0, true)).toEqual(ok(0));
  });
});

describe("rateOverSample", () => {
  it("an unknown population (old cached result) is not evidence of truncation", () => {
    expect(rateOverSample(1, 10, "x", 500, 500, undefined).state).toBe("ok");
  });
});

describe("the page renders these, not the raw fields", () => {
  const page = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");

  it("the Overview rate tiles go through measurementText", () => {
    for (const field of [
      "c.ctrMeasured",
      "c.rateMeasured",
      "c.brandShareMeasured",
      "c.overallRate",
    ]) {
      expect(page, field).toMatch(new RegExp(`measurementText\\(${field.replace(".", "\\.")},`));
    }
    // The deprecated sitemap field is no longer rendered (OPE-808 fixed the
    // loader; the tile kept reading the old `: 0` field).
    expect(page).not.toMatch(/fmtPct\(c\.overall_pass_rate/);
  });

  it("no fmtPct call passes an already-×100 value (0.75 rendered as '7500.0%')", () => {
    const offenders = page.split("\n").filter((l) => /fmtPct\(/.test(l) && /\*\s*100\b/.test(l));
    expect(offenders).toEqual([]);
  });
});
