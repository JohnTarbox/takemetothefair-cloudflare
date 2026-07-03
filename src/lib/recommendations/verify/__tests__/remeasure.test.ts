/**
 * OPE-77 (CPI Move 3) — verify-loop spot-check against better-sqlite3.
 *
 *   1. registry.readMetric(page_1_zero_click_queries) returns the LATEST stored
 *      gsc_search_metrics row for a query (max date).
 *   2. remeasureDueItems disposition, driven against a seeded recommendation_items
 *      row (the acceptance spot-check):
 *        - pending + after-improved  → improved,     actedAt KEPT (cleared).
 *        - pending + after-unchanged → no_movement,  actedAt CLEARED (re-opened).
 *        - pending + no metric yet   → stays pending.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { VERIFY_REGISTRY } from "../registry";
import { remeasureDueItems } from "../remeasure";

const SCHEMA_SQL = `
  CREATE TABLE recommendation_rules (
    id TEXT PRIMARY KEY,
    rule_key TEXT NOT NULL
  );
  CREATE TABLE recommendation_items (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    payload_json TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    dismissed_at INTEGER,
    dismissed_until INTEGER,
    dismissed_reason TEXT,
    acted_at INTEGER,
    verify_status TEXT,
    verify_snapshot TEXT,
    verify_due_at INTEGER,
    verify_remeasured_at INTEGER,
    verify_after TEXT,
    verify_reason TEXT
  );
  CREATE TABLE gsc_search_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    query TEXT NOT NULL,
    page TEXT NOT NULL DEFAULT '/',
    clicks INTEGER NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    ctr REAL NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`;

const RULE_ID = "rule-p1zc";
const RULE_KEY = "page_1_zero_click_queries";
const QUERY = "wickford art festival";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const nowSec = () => Math.floor(Date.now() / 1000);

function seedGsc(opts: {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}) {
  raw
    .prepare(
      `INSERT INTO gsc_search_metrics (date, query, page, clicks, impressions, ctr, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.date,
      QUERY,
      "/events/wickford",
      opts.clicks,
      opts.impressions,
      opts.ctr,
      opts.position
    );
}

function seedPendingItem(opts: { id: string; dueOffsetSec: number }) {
  const snapshot = JSON.stringify({ clicks: 0, impressions: 40, ctr: 0, position: 6.4 });
  raw
    .prepare(
      `INSERT INTO recommendation_items
        (id, rule_id, target_type, target_id, payload_json, first_seen_at, last_seen_at,
         acted_at, verify_status, verify_snapshot, verify_due_at)
       VALUES (?, ?, 'gsc_query', ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      opts.id,
      RULE_ID,
      QUERY,
      snapshot,
      nowSec() - 30 * 86400,
      nowSec() - 30 * 86400,
      nowSec() - 30 * 86400, // acted_at set (item was acted)
      snapshot,
      nowSec() + opts.dueOffsetSec
    );
}

function itemRow(id: string) {
  return raw.prepare(`SELECT * FROM recommendation_items WHERE id = ?`).get(id) as {
    acted_at: number | null;
    verify_status: string | null;
    verify_reason: string | null;
    verify_after: string | null;
    verify_remeasured_at: number | null;
  };
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(`INSERT INTO recommendation_rules (id, rule_key) VALUES (?, ?)`)
    .run(RULE_ID, RULE_KEY);
});
afterEach(() => raw.close());

describe("registry.readMetric — page_1_zero_click_queries", () => {
  it("returns the latest (max-date) stored gsc row for the query", async () => {
    seedGsc({ date: "2026-06-01", clicks: 0, impressions: 30, ctr: 0, position: 7.2 });
    seedGsc({ date: "2026-06-20", clicks: 4, impressions: 61, ctr: 0.065, position: 5.0 });
    seedGsc({ date: "2026-06-10", clicks: 1, impressions: 44, ctr: 0.022, position: 6.1 });

    const after = await VERIFY_REGISTRY[RULE_KEY].readMetric(db as never, {
      targetId: QUERY,
      payloadJson: null,
    });
    expect(after).toEqual({ clicks: 4, impressions: 61, ctr: 0.065, position: 5.0 });
  });

  it("returns null when there's no stored row for the query", async () => {
    const after = await VERIFY_REGISTRY[RULE_KEY].readMetric(db as never, {
      targetId: "no-such-query",
      payloadJson: null,
    });
    expect(after).toBeNull();
  });
});

describe("remeasureDueItems — disposition spot-check", () => {
  it("improved: after now has clicks → verify_status=improved, actedAt KEPT", async () => {
    seedPendingItem({ id: "i1", dueOffsetSec: -100 }); // due
    seedGsc({ date: "2026-06-25", clicks: 3, impressions: 55, ctr: 0.054, position: 5.1 });

    const r = await remeasureDueItems(db as never, new Date());
    expect(r).toMatchObject({ remeasured: 1, improved: 1, noMovement: 0, stillPending: 0 });

    const row = itemRow("i1");
    expect(row.verify_status).toBe("improved");
    expect(row.verify_reason).toBe("clicks 0 → 3");
    expect(row.acted_at).not.toBeNull(); // stays acted (cleared)
    expect(row.verify_remeasured_at).not.toBeNull();
  });

  it("no_movement: still zero clicks → verify_status=no_movement, actedAt CLEARED (re-opened)", async () => {
    seedPendingItem({ id: "i1", dueOffsetSec: -100 });
    seedGsc({ date: "2026-06-25", clicks: 0, impressions: 70, ctr: 0, position: 6.4 });

    const r = await remeasureDueItems(db as never, new Date());
    expect(r).toMatchObject({ remeasured: 1, improved: 0, noMovement: 1, stillPending: 0 });

    const row = itemRow("i1");
    expect(row.verify_status).toBe("no_movement");
    expect(row.verify_reason).toBe("still 0 clicks (position 6.4)");
    expect(row.acted_at).toBeNull(); // re-opened into the active set
  });

  it("no stored metric yet → left pending, retried next run", async () => {
    seedPendingItem({ id: "i1", dueOffsetSec: -100 });
    // no gsc rows seeded

    const r = await remeasureDueItems(db as never, new Date());
    expect(r).toMatchObject({ remeasured: 0, improved: 0, noMovement: 0, stillPending: 1 });
    expect(itemRow("i1").verify_status).toBe("pending"); // unchanged
  });

  it("does not touch items whose verify_due_at is still in the future", async () => {
    seedPendingItem({ id: "i1", dueOffsetSec: 7 * 86400 }); // due in 7 days
    seedGsc({ date: "2026-06-25", clicks: 3, impressions: 55, ctr: 0.05, position: 5.1 });

    const r = await remeasureDueItems(db as never, new Date());
    expect(r).toMatchObject({ remeasured: 0, improved: 0, noMovement: 0, stillPending: 0 });
    expect(itemRow("i1").verify_status).toBe("pending");
  });
});
