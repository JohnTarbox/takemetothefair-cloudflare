/**
 * OPE-102 — persist=true on the URL-inspection tools must land a state-table row
 * matching the returned verdict/coverage (GSC) or indexed/crawl fields (Bing),
 * and be idempotent (upsert, not duplicate-insert).
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import type { Database as AppDb } from "../db";
import {
  persistGscInspectionState,
  persistBingInspectionState,
  MCP_TOOL_SOURCE,
} from "../inspection-state-persist";

const SCHEMA_SQL = `
  CREATE TABLE gsc_inspection_state (
    url TEXT PRIMARY KEY,
    last_inspected_at INTEGER NOT NULL,
    last_verdict TEXT,
    last_coverage_state TEXT,
    source TEXT NOT NULL DEFAULT 'sitemap'
  );
  CREATE TABLE bing_inspection_state (
    url TEXT PRIMARY KEY,
    is_indexed INTEGER,
    last_crawled INTEGER,
    crawl_error TEXT,
    last_checked_at INTEGER
  );
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

describe("persistGscInspectionState (OPE-102)", () => {
  it("inserts a row with verdict, coverage, and the mcp-tool source label", async () => {
    await persistGscInspectionState(db, {
      url: "https://meetmeatthefair.com/blog/x",
      verdict: "PASS",
      coverage: "Submitted and indexed",
      now: new Date(1_700_000_000_000),
    });
    const row = raw
      .prepare("SELECT * FROM gsc_inspection_state WHERE url = ?")
      .get("https://meetmeatthefair.com/blog/x") as Record<string, unknown>;
    expect(row.last_verdict).toBe("PASS");
    expect(row.last_coverage_state).toBe("Submitted and indexed");
    expect(row.source).toBe(MCP_TOOL_SOURCE);
    expect(row.last_inspected_at).toBe(1_700_000_000); // seconds-epoch (timestamp mode)
  });

  it("is idempotent — a second call upserts (no duplicate, fields refreshed)", async () => {
    const url = "https://meetmeatthefair.com/events/y";
    await persistGscInspectionState(db, { url, verdict: "NEUTRAL", coverage: null });
    await persistGscInspectionState(db, {
      url,
      verdict: "PASS",
      coverage: "Submitted and indexed",
    });
    const rows = raw.prepare("SELECT * FROM gsc_inspection_state WHERE url = ?").all(url);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).last_verdict).toBe("PASS");
  });

  it("defaults a nullish verdict to UNKNOWN (mirrors the sweep)", async () => {
    await persistGscInspectionState(db, {
      url: "https://meetmeatthefair.com/z",
      verdict: undefined,
      coverage: undefined,
    });
    const row = raw
      .prepare("SELECT * FROM gsc_inspection_state WHERE url = ?")
      .get("https://meetmeatthefair.com/z") as Record<string, unknown>;
    expect(row.last_verdict).toBe("UNKNOWN");
    expect(row.last_coverage_state).toBeNull();
  });
});

describe("persistBingInspectionState (OPE-102)", () => {
  it("inserts indexed/crawl fields, converting the ISO lastCrawled to a timestamp", async () => {
    await persistBingInspectionState(db, {
      url: "https://meetmeatthefair.com/blog/x",
      isIndexed: true,
      lastCrawled: "2026-07-04T00:00:00.000Z",
      crawlError: null,
      now: new Date(1_700_000_500_000),
    });
    const row = raw
      .prepare("SELECT * FROM bing_inspection_state WHERE url = ?")
      .get("https://meetmeatthefair.com/blog/x") as Record<string, unknown>;
    expect(row.is_indexed).toBe(1);
    expect(row.crawl_error).toBeNull();
    expect(row.last_crawled).toBe(Math.floor(Date.parse("2026-07-04T00:00:00.000Z") / 1000));
    expect(row.last_checked_at).toBe(1_700_000_500);
  });

  it("stores a null lastCrawled when the tool returns null (never crawled)", async () => {
    await persistBingInspectionState(db, {
      url: "https://meetmeatthefair.com/blog/never",
      isIndexed: false,
      lastCrawled: null,
      crawlError: null,
    });
    const row = raw
      .prepare("SELECT * FROM bing_inspection_state WHERE url = ?")
      .get("https://meetmeatthefair.com/blog/never") as Record<string, unknown>;
    expect(row.is_indexed).toBe(0);
    expect(row.last_crawled).toBeNull();
  });

  it("is idempotent — a re-inspect upserts the same row", async () => {
    const url = "https://meetmeatthefair.com/blog/y";
    await persistBingInspectionState(db, {
      url,
      isIndexed: false,
      lastCrawled: null,
      crawlError: "5xx",
    });
    await persistBingInspectionState(db, {
      url,
      isIndexed: true,
      lastCrawled: "2026-07-05T00:00:00.000Z",
      crawlError: null,
    });
    const rows = raw.prepare("SELECT * FROM bing_inspection_state WHERE url = ?").all(url);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).is_indexed).toBe(1);
    expect((rows[0] as Record<string, unknown>).crawl_error).toBeNull();
  });
});
