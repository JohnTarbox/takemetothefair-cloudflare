/**
 * OPE-1161 batch 2 — A2, A4, A5, A6, A7, B8, D12. Each case asserts the NEW
 * behaviour so it fails on the old code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../db/schema";
import type { Db } from "../shared";

const organic = vi.fn(async (_env: unknown, _start: string, _end: string) => 100);
vi.mock("@/lib/ga4", async (orig) => ({
  ...(await orig<typeof import("@/lib/ga4")>()),
  getOrganicSessions: (env: unknown, s: string, e: string) => organic(env, s, e),
}));

import { getAeoBucket } from "@/lib/ga4";
import { getTrafficReport } from "@/lib/site-health-unified/traffic";
import { trafficReading } from "@/lib/site-health-unified/readings";
import { loadRenderFaultHealth } from "../fault-health";
import { loadBlogCoverage } from "../content";

const PAGE = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");
let raw: Database.Database;
let db: Db;
beforeEach(() => {
  raw = new Database(":memory:");
  db = drizzle(raw, { schema }) as unknown as Db;
  organic.mockClear();
});

describe("A2 — server-message share is a share of RENDER errors", () => {
  it("API errors and info rows are not in the denominator", async () => {
    raw.exec(`
      CREATE TABLE fault_signatures (id TEXT PRIMARY KEY, status TEXT, ope_id TEXT, count INTEGER,
        first_seen INTEGER, filed_at INTEGER);
      CREATE TABLE error_logs (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT, source TEXT);
    `);
    const ins = raw.prepare(
      "INSERT INTO error_logs (id, timestamp, level, source) VALUES (?, ?, ?, ?)"
    );
    const t = Math.floor(Date.now() / 1000);
    ins.run("s1", t, "error", "server-render");
    ["c1", "c2", "c3"].forEach((id) => ins.run(id, t, "error", "client"));
    for (let i = 0; i < 10; i++) ins.run(`a${i}`, t, "error", "api/x");
    const card = await loadRenderFaultHealth(db, 1);
    expect(card.serverMessagePct).toBe(0.25);
  });
});

describe("A4 — the traffic tile shows sessions; the verdict count stays 1/0", () => {
  it("displayValue is the session count, actionItems the drop flag", () => {
    const r = trafficReading({
      windowDays: 7,
      current: 412,
      previous: 400,
      deltaPct: 0.03,
      windowEndDate: "2026-09-23",
    });
    expect(r.displayValue).toBe(412);
    expect(r.actionItems).toBe(0);
    expect(PAGE).toContain(
      "reading.displayValue !== undefined ? reading.displayValue : reading.actionItems"
    );
  });
});

describe("B8 — '7d' is seven inclusive days, and the windows do not overlap", () => {
  it("requests 09-17..09-23 and 09-10..09-16 on 2026-09-25", async () => {
    await getTrafficReport({} as never, { now: new Date("2026-09-25T12:00:00Z") });
    const ranges = organic.mock.calls.map((c) => [c[1], c[2]]);
    expect(ranges).toContainEqual(["2026-09-17", "2026-09-23"]);
    expect(ranges).toContainEqual(["2026-09-10", "2026-09-16"]);
  });
});

describe("A5 — no card is labelled 'overrides' when none can be counted", () => {
  it("relabelled to what the query counts", () => {
    expect(PAGE).not.toContain('label="Operator overrides"');
    expect(PAGE).toContain('label="Operator discrepancy actions"');
  });
});

describe("A6 — DuckDuckGo is not an AI referrer", () => {
  it("search and no-AI DuckDuckGo hosts are not bucketed; real AI hosts still are", () => {
    expect(getAeoBucket("duckduckgo.com")).toBeNull();
    expect(getAeoBucket("noai.duckduckgo.com")).toBeNull();
    expect(getAeoBucket("perplexity.ai")).toBe("perplexity");
    expect(getAeoBucket("kagi.com")).toBe("other");
  });
});

describe("A7 — blog coverage counts only inside its own denominator", () => {
  it("draft links, non-approved events and soft-deleted vendors are not coverage", async () => {
    raw.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE vendors (id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE venues (id TEXT PRIMARY KEY);
      CREATE TABLE blog_posts (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE content_links (id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT,
        target_type TEXT, target_slug TEXT, target_id TEXT);
      INSERT INTO events VALUES ('e1','APPROVED'),('e2','APPROVED'),('e3','PENDING');
      INSERT INTO vendors VALUES ('v1',NULL),('v2',1700000000);
      INSERT INTO blog_posts VALUES ('pub','PUBLISHED'),('draft','DRAFT');
      INSERT INTO content_links VALUES
        ('l1','BLOG_POST','pub','EVENT','x','e1'),
        ('l2','BLOG_POST','draft','EVENT','x','e2'),
        ('l3','BLOG_POST','pub','EVENT','x','e3'),
        ('l4','BLOG_POST','pub','VENDOR','x','v2');
    `);
    const card = await loadBlogCoverage(db);
    // e1 covered; e2 only by a draft; e3 is not APPROVED → 1 of 2 uncovered.
    expect(card.events).toEqual({ uncovered: 1, total: 2 });
    // v2 is soft-deleted: not in the total, and its link covers nothing.
    expect(card.vendors).toEqual({ uncovered: 1, total: 1 });
  });
});

describe("D12 — the Google tab's top 25 is by clicks, as labelled", () => {
  it("asks the helper for clicks ordering", () => {
    expect(PAGE).toContain('getSiteSearchQueries(env, { rowLimit: 25, orderBy: "clicks" })');
  });
});

describe("B9 — an N-day window is N inclusive days, for both GSC cards", () => {
  it("30d uses the 30-day preset; other windows span exactly N days", async () => {
    const { gscWindowRange } = await import("../shared");
    expect(gscWindowRange(30)).toEqual({ preset: "last_30d" });
    expect(gscWindowRange(7)).toEqual({ preset: "last_7d" });
    const one = gscWindowRange(1) as { startDate: string; endDate: string };
    expect(one.startDate).toBe(one.endDate); // 1 day, not 2
    const fourteen = gscWindowRange(14) as { startDate: string; endDate: string };
    const span = (Date.parse(fourteen.endDate) - Date.parse(fourteen.startDate)) / 86400_000 + 1;
    expect(span).toBe(14);
  });

  it("both cards use it", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/analytics-overview/search-visibility.ts"),
      "utf8"
    );
    expect(src.split("gscWindowRange(days)").length - 1).toBe(2);
    expect(src).not.toContain('30: "last_28d"');
  });
});

describe("B10 — publishing: no 90-day chart over 30-day data; paused is not zero", () => {
  it("the 90d publishing card is gone and the 30d one takes the pause", () => {
    expect(PAGE).not.toContain('title="Publishing activity (last 90 days)"');
    expect(PAGE).toContain('snapshot.indexnow.pause.state === "paused"');
    expect(PAGE).toContain(
      "const total = pausedReason ? unavailable(pausedReason) : sparklineTotal(points, feed);"
    );
  });
});
