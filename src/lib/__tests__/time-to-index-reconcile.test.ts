/**
 * REL5 (2026-06-26) — reconcileTimeToIndexFromCrawl gating logic.
 * In-memory better-sqlite3 harness with an injected crawl lookup (no live Bing).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { reconcileTimeToIndexFromCrawl, type CrawlLookup } from "../time-to-index-reconcile";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const SCHEMA_SQL = `
  CREATE TABLE time_to_index_log (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    indexnow_submitted_at INTEGER NOT NULL,
    first_crawl_at INTEGER,
    lag_seconds INTEGER,
    computed_at INTEGER NOT NULL
  );
`;

let raw: Database.Database;
let db: TestDb;

const SUBMIT_ISO = "2026-06-01T00:00:00Z";
const submitSec = Math.floor(new Date(SUBMIT_ISO).getTime() / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

function seed(id: string, url: string, submittedIso = SUBMIT_ISO) {
  const s = Math.floor(new Date(submittedIso).getTime() / 1000);
  raw
    .prepare(
      `INSERT INTO time_to_index_log (id, url, indexnow_submitted_at, computed_at) VALUES (?, ?, ?, ?)`
    )
    .run(id, url, s, s);
}

function firstCrawl(id: string): number | null {
  const r = raw
    .prepare(`SELECT first_crawl_at AS f, lag_seconds AS l FROM time_to_index_log WHERE id = ?`)
    .get(id) as { f: number | null; l: number | null } | undefined;
  return r?.f ?? null;
}
function lag(id: string): number | null {
  const r = raw.prepare(`SELECT lag_seconds AS l FROM time_to_index_log WHERE id = ?`).get(id) as
    | { l: number | null }
    | undefined;
  return r?.l ?? null;
}

describe("reconcileTimeToIndexFromCrawl", () => {
  it("resolves a row whose Bing crawl is AFTER submission, with correct lag", async () => {
    seed("a", "https://meetmeatthefair.com/events/x");
    // crawled 2h after submission
    const crawledIso = new Date((submitSec + 7200) * 1000).toISOString();
    const lookup: CrawlLookup = async () => ({ lastCrawled: crawledIso });

    const res = await reconcileTimeToIndexFromCrawl(db as never, lookup, { limit: 50 });
    expect(res.reconciled).toBe(1);
    expect(res.checked).toBe(1);
    expect(firstCrawl("a")).not.toBeNull();
    expect(lag("a")).toBe(7200);
  });

  it("does NOT resolve when Bing's lastCrawled predates submission (no re-crawl yet)", async () => {
    seed("b", "https://meetmeatthefair.com/events/y");
    const beforeIso = new Date((submitSec - 3600) * 1000).toISOString();
    const res = await reconcileTimeToIndexFromCrawl(
      db as never,
      async () => ({ lastCrawled: beforeIso }),
      {
        limit: 50,
      }
    );
    expect(res.reconciled).toBe(0);
    expect(res.checked).toBe(1); // looked up, but left unresolved
    expect(firstCrawl("b")).toBeNull();
  });

  it("leaves never-crawled rows (lastCrawled null) unresolved", async () => {
    seed("c", "https://meetmeatthefair.com/events/z");
    const res = await reconcileTimeToIndexFromCrawl(
      db as never,
      async () => ({ lastCrawled: null }),
      {
        limit: 50,
      }
    );
    expect(res.reconciled).toBe(0);
    expect(firstCrawl("c")).toBeNull();
  });

  it("stops early on a 429 (quota) and reports quotaStopped", async () => {
    seed("a", "https://meetmeatthefair.com/a", "2026-06-01T00:00:00Z");
    seed("b", "https://meetmeatthefair.com/b", "2026-06-02T00:00:00Z");
    const lookup: CrawlLookup = async (url) => {
      if (url.endsWith("/a")) {
        const e = Object.assign(new Error("Too Many Requests"), { status: 429 });
        throw e;
      }
      return { lastCrawled: null };
    };
    const res = await reconcileTimeToIndexFromCrawl(db as never, lookup, { limit: 50 });
    expect(res.quotaStopped).toBe(true);
    // '/a' is oldest (ordered ASC), so it's hit first → break before '/b'.
    expect(res.checked).toBe(0);
  });

  it("counts non-429 errors and continues", async () => {
    seed("a", "https://meetmeatthefair.com/a", "2026-06-01T00:00:00Z");
    seed("b", "https://meetmeatthefair.com/b", "2026-06-02T00:00:00Z");
    const crawledIso = new Date(
      (Math.floor(new Date("2026-06-02T00:00:00Z").getTime() / 1000) + 60) * 1000
    ).toISOString();
    const lookup: CrawlLookup = async (url) => {
      if (url.endsWith("/a")) throw new Error("network blip");
      return { lastCrawled: crawledIso };
    };
    const res = await reconcileTimeToIndexFromCrawl(db as never, lookup, { limit: 50 });
    expect(res.errors).toBe(1);
    expect(res.reconciled).toBe(1); // '/b' still resolves
    expect(res.quotaStopped).toBe(false);
  });

  it("respects the limit and reports scanned = total unresolved", async () => {
    for (let i = 0; i < 5; i++) seed(`r${i}`, `https://meetmeatthefair.com/e${i}`);
    let calls = 0;
    const res = await reconcileTimeToIndexFromCrawl(
      db as never,
      async () => {
        calls++;
        return { lastCrawled: null };
      },
      { limit: 2 }
    );
    expect(res.scanned).toBe(5); // total unresolved
    expect(calls).toBe(2); // only `limit` rows looked up
  });
});
