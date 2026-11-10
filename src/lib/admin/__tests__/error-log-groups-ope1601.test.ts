/**
 * OPE-1601 — /admin/logs groups repeats, against real SQLite for the loader.
 * Messages are prod shapes read from error_logs on 2026-11-09.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  loadErrorLogGroups,
  logSearchHint,
  mergeLogBuckets,
  type ErrorLogBucket,
} from "../error-log-groups";

const bucket = (over: Partial<ErrorLogBucket>): ErrorLogBucket => ({
  source: "faults:rail-health",
  level: "warn",
  message: "69 fileable signature(s) have sat unfiled for more than 7 days (oldest 46d)",
  count: 1,
  firstSeenSec: 100,
  lastSeenSec: 100,
  ...over,
});

describe("mergeLogBuckets", () => {
  it("shows a message that repeats with changing numbers once, with the full count", () => {
    const groups = mergeLogBuckets([
      bucket({ count: 3, firstSeenSec: 100, lastSeenSec: 300 }),
      bucket({
        message: "70 fileable signature(s) have sat unfiled for more than 7 days (oldest 47d)",
        count: 5,
        firstSeenSec: 400,
        lastSeenSec: 900,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 8, firstSeenSec: 100, lastSeenSec: 900 });
    // The example is the largest bucket's message, as stored.
    expect(groups[0].example).toContain("70 fileable");
  });

  it("keeps different sources, levels and messages apart", () => {
    const groups = mergeLogBuckets([
      bucket({}),
      bucket({ source: "other" }),
      bucket({ level: "error" }),
      bucket({ message: "cron task 'fault-signatures emit' returned 503 with no body" }),
    ]);
    expect(groups).toHaveLength(4);
  });

  it("orders by count", () => {
    const groups = mergeLogBuckets([
      bucket({ source: "small", count: 1 }),
      bucket({ source: "big", count: 9 }),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["big", "small"]);
  });

  it("labels a row with no source instead of dropping it", () => {
    expect(mergeLogBuckets([bucket({ source: null })])[0].source).toBe("(unknown)");
  });
});

describe("logSearchHint", () => {
  it("uses the digit-free run, so the raw search finds every occurrence", () => {
    expect(logSearchHint("69 fileable signature(s) have sat unfiled for more than 7 days")).toBe(
      "fileable signature(s) have sat unfiled for more than"
    );
  });

  it("stops at a newline", () => {
    expect(logSearchHint("Fetch failed (getPerformer)\ncause: Failed query: select")).toBe(
      "Fetch failed (getPerformer)"
    );
  });

  it("gives no hint when nothing stable is long enough", () => {
    expect(logSearchHint("12 ab 34")).toBe("");
  });
});

describe("loadErrorLogGroups", () => {
  const sec = (daysAgo = 0) => Math.floor(Date.now() / 1000) - daysAgo * 86400;
  const since = new Date(Date.now() - 7 * 86400 * 1000);
  let raw: InstanceType<typeof Database>;
  let db: never;
  let insert: (id: string, ts: number, level: string, message: string, source: string) => void;

  beforeEach(() => {
    raw = new Database(":memory:");
    raw["exec"](`CREATE TABLE error_logs (id TEXT PRIMARY KEY, timestamp INTEGER, level TEXT,
      message TEXT, context TEXT, url TEXT, method TEXT, status_code INTEGER, stack_trace TEXT,
      user_agent TEXT, source TEXT);`);
    db = drizzle(raw, { schema }) as never;
    const statement = raw.prepare(
      "INSERT INTO error_logs (id,timestamp,level,message,source) VALUES (?,?,?,?,?)"
    );
    insert = (...args) => void statement.run(...args);
  });

  it("collapses repeats in SQL and counts every row", async () => {
    insert("1", sec(1), "warn", "69 fileable signature(s) unfiled", "faults");
    insert("2", sec(2), "warn", "69 fileable signature(s) unfiled", "faults");
    insert("3", sec(3), "warn", "70 fileable signature(s) unfiled", "faults");
    insert("4", sec(1), "error", "D1 timeout", "db");

    const result = await loadErrorLogGroups(db, { since });

    expect(result.totalRows).toBe(4);
    expect(result.totalGroups).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.groups[0]).toMatchObject({ source: "faults", level: "warn", count: 3 });
    expect(result.groups[0].firstSeenSec).toBe(sec(3));
    expect(result.groups[0].lastSeenSec).toBe(sec(1));
  });

  it("leaves out rows older than the window", async () => {
    insert("old", sec(9), "error", "ancient", "db");
    insert("new", sec(1), "error", "recent", "db");
    const { groups } = await loadErrorLogGroups(db, { since });
    expect(groups.map((g) => g.example)).toEqual(["recent"]);
  });

  it("returns info rows only when info is asked for", async () => {
    insert("i", sec(1), "info", "AI extraction ok", "extract");
    insert("e", sec(1), "error", "D1 timeout", "db");
    const byDefault = await loadErrorLogGroups(db, { since });
    expect(byDefault.groups.map((g) => g.level)).toEqual(["error"]);
    const info = await loadErrorLogGroups(db, { since, level: "info" });
    expect(info.groups.map((g) => g.level)).toEqual(["info"]);
  });

  it("applies the source and text filters", async () => {
    insert("a", sec(1), "error", "D1 timeout", "app/vendors");
    insert("b", sec(1), "error", "Chunk failed", "client");
    const bySource = await loadErrorLogGroups(db, { since, source: "VENDORS" });
    expect(bySource.groups.map((g) => g.source)).toEqual(["app/vendors"]);
    const byText = await loadErrorLogGroups(db, { since, q: "chunk" });
    expect(byText.groups.map((g) => g.source)).toEqual(["client"]);
  });
});
