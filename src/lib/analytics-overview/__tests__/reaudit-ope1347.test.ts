/**
 * OPE-1347 — the 2026-10-13 analytics re-audit. Each test pins one defect to the
 * code that produces the number, against real SQLite where the number is a query.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { sumSitemapContents } from "@/lib/search-console";
import { resolveTabAlias } from "../tab-aliases";
import { loadSiteCtr } from "../search-visibility";
import { loadErrorGroups, loadIndexNowHealth } from "@/lib/diagnostics";

let raw: InstanceType<typeof Database>;
let db: never;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](`
    CREATE TABLE gsc_daily_totals (site_url TEXT, date TEXT, clicks INTEGER, impressions INTEGER,
      ctr REAL, position REAL, updated_at INTEGER);
    CREATE TABLE error_logs (id TEXT PRIMARY KEY, timestamp INTEGER, level TEXT, message TEXT,
      context TEXT, url TEXT, method TEXT, status_code INTEGER, stack_trace TEXT, user_agent TEXT,
      source TEXT);
    CREATE TABLE indexnow_submissions (id TEXT PRIMARY KEY, timestamp INTEGER, source TEXT, urls TEXT,
      url_count INTEGER, status TEXT, status_code INTEGER, error_message TEXT, response_time_ms INTEGER);
  `);
  db = drizzle(raw, { schema }) as never;
});

describe("#1 sitemap denominator counts each URL once", () => {
  const child = (path: string, n: number) => ({ path, contents: [{ submitted: n, indexed: 1 }] });

  it("drops the index sitemap when children are listed (the 21,060 vs 10,530 shape)", () => {
    const children = [1500, 1500, 1500, 1500, 1500, 1500, 1530].map((n, i) =>
      child(`/sitemap-${i}.xml`, n)
    );
    const index = {
      path: "/sitemap.xml",
      isSitemapsIndex: true,
      contents: [{ submitted: 10530, indexed: 7 }],
    };
    expect(sumSitemapContents([index, ...children]).submitted).toBe(10530);
    // Path alone is enough when GSC omits the flag.
    expect(
      sumSitemapContents([{ ...index, isSitemapsIndex: undefined }, ...children]).submitted
    ).toBe(10530);
  });

  it("an index submitted ALONE still counts (otherwise the total would read 0)", () => {
    expect(
      sumSitemapContents([
        { path: "/sitemap.xml", isSitemapsIndex: true, contents: [{ submitted: 42, indexed: 1 }] },
      ]).submitted
    ).toBe(42);
  });
});

describe("#7 near-miss tab slugs", () => {
  it("first-party → first-party-events; unknown → undefined (the page 404s)", () => {
    expect(resolveTabAlias("first-party")).toBe("first-party-events");
    expect(resolveTabAlias("First-Party")).toBe("first-party-events");
    expect(resolveTabAlias("nonsense")).toBeUndefined();
  });
});

describe("#4/#5 site CTR sub-lines come from gsc_daily_totals over the badge window", () => {
  const day = (offset: number) =>
    new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const ins = (date: string, clicks: number, impressions: number) =>
    raw
      .prepare("INSERT INTO gsc_daily_totals VALUES (?,?,?,?,0,0,0)")
      .run("x", date, clicks, impressions);

  it("sums the 2-day-lagged window and the equal prior window, and names the dates", async () => {
    // Inside the current window: days 2..8 ago (end exclusive at 2 days ago).
    for (let d = 3; d <= 9; d++) ins(day(d), 100, 5000);
    // The excluded, not-yet-final days.
    ins(day(1), 999, 1);
    ins(day(0), 999, 1);
    // Prior window: days 10..16 ago.
    for (let d = 10; d <= 16; d++) ins(day(d), 50, 5000);

    const c = await loadSiteCtr(db, 7);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.clicks).toBe(700); // the late days (999) are excluded
    expect(c.impressions).toBe(35000);
    expect(c.ctrMeasured).toMatchObject({ state: "ok" });
    expect(c.previousMeasured.state).toBe("ok");
    expect(c.previousCtr).toBeCloseTo(350 / 35000, 6);
    expect(c.windowEnd).toBe(day(3));
    expect(c.windowStart).toBe(day(9));
  });

  it("no rows → not ok (never a 0% CTR)", async () => {
    const c = await loadSiteCtr(db, 7);
    expect(c.ok).toBe(false);
  });
});

describe("#6 diagnostics", () => {
  const since = new Date(Date.now() - 7 * 86400000);
  const sec = () => Math.floor(Date.now() / 1000);

  it("IndexNow over ZERO attempts (every row skipped) is undefined, not 0.0%", async () => {
    const ins = raw.prepare(
      "INSERT INTO indexnow_submissions (id,timestamp,source,urls,url_count,status) VALUES (?,?,?,?,?,?)"
    );
    for (let i = 0; i < 5; i++) ins.run(`s${i}`, sec(), "x", "[]", 1, "skipped");
    const h = await loadIndexNowHealth(db, since);
    expect(h.total).toBe(5); // landmark: rows exist
    expect(h.successMeasured.state).toBe("undefined-rate");
  });

  it("IndexNow with real attempts is a rate over success + failure only", async () => {
    const ins = raw.prepare(
      "INSERT INTO indexnow_submissions (id,timestamp,source,urls,url_count,status) VALUES (?,?,?,?,?,?)"
    );
    ins.run("a", sec(), "x", "[]", 1, "success");
    ins.run("b", sec(), "x", "[]", 1, "failure");
    ins.run("c", sec(), "x", "[]", 1, "skipped");
    const h = await loadIndexNowHealth(db, since);
    expect(h.successMeasured).toMatchObject({ state: "ok", value: 0.5 });
  });

  it("'Recent errors grouped' holds error-level rows only", async () => {
    const ins = raw.prepare(
      "INSERT INTO error_logs (id,timestamp,level,message,source) VALUES (?,?,?,?,?)"
    );
    ins.run("1", sec(), "info", "AI extraction ok", "extract");
    ins.run("2", sec(), "info", "classifier result", "classify");
    ins.run("3", sec(), "error", "D1 timeout", "db");
    const groups = await loadErrorGroups(db, since);
    expect(groups.map((g) => g.message)).toEqual(["D1 timeout"]);
  });
});
