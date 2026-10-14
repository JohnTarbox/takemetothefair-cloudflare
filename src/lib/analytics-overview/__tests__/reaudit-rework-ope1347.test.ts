/**
 * OPE-1347 rework — the 2026-10-13 23:55Z served-surface review's PARTIALs.
 *
 * #4  brand share over the top-500 sample: a capped sample with no brand row is
 *     a SAMPLE FLOOR, not 0% (prod: 2 brand clicks / 12 impressions over
 *     10-04→11 vs 3,236 clicks; the tile read "0 of 108,170").
 * Blog coverage gaps: the last card still counting APPROVED-only events and
 *     ALL venues. It now uses catalog-basis.ts like every other card.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { brandShareOverSample } from "../search-visibility";
import { loadBlogCoverage } from "../content";

describe("#4 brand share over a capped sample", () => {
  it("capped sample, no brand row → not a number (the 0-of-108,170 shape)", () => {
    const m = brandShareOverSample(0, 0, 6902, 500, 500, 4100);
    expect(m.state).toBe("truncated");
    expect(m.value).toBeNull();
    expect(m.reason).toMatch(/below the sample floor/);
  });

  it("complete sample (cap not hit), no brand row → a real 0", () => {
    const m = brandShareOverSample(0, 0, 120, 80, 500, 80);
    expect(m).toMatchObject({ state: "ok", value: 0 });
  });

  it("a brand row in a capped sample → the sampled rate, flagged truncated", () => {
    const m = brandShareOverSample(33, 336, 6902, 500, 500, 4100);
    expect(m.state).toBe("truncated");
    expect(m.value).toBeCloseTo(33 / 6902, 6);
  });

  it("no clicks at all → undefined rate, never 0%", () => {
    expect(brandShareOverSample(0, 0, 0, 500, 500, 4100).state).toBe("undefined-rate");
  });
});

describe("Blog coverage gaps uses the shared catalog basis", () => {
  let raw: InstanceType<typeof Database>;
  let db: never;
  beforeEach(() => {
    raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY, status TEXT, lifecycle_status TEXT);
      CREATE TABLE vendors (id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE venues (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE blog_posts (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE content_links (id TEXT PRIMARY KEY, source_id TEXT, target_type TEXT, target_id TEXT);
      INSERT INTO events VALUES
        ('e1','APPROVED','SCHEDULED'),   -- public
        ('e2','TENTATIVE','SCHEDULED'),  -- public: the 296 the old basis dropped
        ('e5','TENTATIVE','SCHEDULED'),  -- a 2nd, so APPROVED-only cannot tie by luck
        ('e3','APPROVED','CANCELLED'),   -- not public
        ('e4','PENDING','SCHEDULED');    -- not public
      INSERT INTO vendors VALUES ('v1',NULL),('v2',1700000000);
      INSERT INTO venues VALUES ('n1','ACTIVE'),('n2','INACTIVE');
      INSERT INTO blog_posts VALUES ('b1','PUBLISHED'),('b2','DRAFT');
      INSERT INTO content_links VALUES
        ('l1','b1','EVENT','e2'),  -- covers a TENTATIVE public event
        ('l2','b1','EVENT','e3'),  -- links a cancelled event: outside the total
        ('l3','b2','EVENT','e1'),  -- draft post: does not cover
        ('l4','b1','VENUE','n2'),  -- inactive venue: outside the total
        ('l5','b1','VENUE','n1');
    `);
    db = drizzle(raw, { schema }) as never;
  });

  it("events = public (APPROVED + TENTATIVE, not cancelled); venues = ACTIVE", async () => {
    const c = await loadBlogCoverage(db);
    // Landmark: 5 events / 2 venues / 2 vendors were seeded, so each total
    // below is a FILTER result, not an empty table.
    const seeded = raw
      .prepare("SELECT (SELECT COUNT(*) FROM events) e, (SELECT COUNT(*) FROM venues) v")
      .get();
    expect(seeded).toEqual({ e: 5, v: 2 });
    // Public = e1, e2, e5 (3); APPROVED-only would be e1, e3 (2). e2 is covered.
    expect(c.events).toEqual({ total: 3, uncovered: 2 });
    expect(c.venues).toEqual({ total: 1, uncovered: 0 });
    expect(c.vendors).toEqual({ total: 1, uncovered: 1 });
  });
});
