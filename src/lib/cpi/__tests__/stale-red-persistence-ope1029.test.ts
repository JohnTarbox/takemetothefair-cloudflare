/**
 * OPE-1029 — the stale-red resolve pass must stay inside D1's 100-bound-param
 * cap at a realistic signal count, and must still resolve what cleared.
 *
 * better-sqlite3 accepts 32,766 params, so without the statement-shape counter
 * below this suite would pass with the 391-bind NOT IN in place.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { persistStaleRedSignals } from "../stale-red-persistence";
import type { StaleRed } from "../stale-reds";

const DDL = `
CREATE TABLE stale_red_signals (
  ref_key TEXT PRIMARY KEY,
  priority TEXT NOT NULL,
  title TEXT NOT NULL,
  href TEXT,
  first_detected_at INTEGER,
  hours_in_red REAL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER
);`;

const D1_MAX_BOUND_PARAMS = 100;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let maxParams = 0;
let statements = 0;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(DDL);
  // Count bound parameters per prepared statement — D1's real constraint.
  const prepare = raw.prepare.bind(raw);
  (raw as unknown as { prepare: typeof raw.prepare }).prepare = ((sql: string) => {
    statements++;
    maxParams = Math.max(maxParams, (sql.match(/\?/g) ?? []).length);
    return prepare(sql);
  }) as typeof raw.prepare;
  maxParams = 0;
  statements = 0;
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

const red = (i: number): StaleRed => ({
  priority: "P1",
  title: `signal ${i}`,
  refKey: `cpi:kpi:k${i}`,
  href: "https://meetmeatthefair.com/admin",
  firstDetectedAt: "2026-09-01T00:00:00Z",
  hoursInRed: 10,
});

const openKeys = () =>
  (
    raw
      .prepare("SELECT ref_key FROM stale_red_signals WHERE resolved_at IS NULL ORDER BY ref_key")
      .all() as { ref_key: string }[]
  ).map((r) => r.ref_key);

describe("persistStaleRedSignals", () => {
  it("at 391 live signals (the prod count) no statement exceeds D1's bound-param cap", async () => {
    const reds = Array.from({ length: 391 }, (_, i) => red(i));
    await persistStaleRedSignals(db as never, reds, new Date("2026-09-15T06:00:00Z"));
    // Positive landmark: statements ran, so the max is not a vacuous 0.
    expect(statements).toBeGreaterThan(391);
    expect(maxParams).toBeGreaterThan(0);
    expect(maxParams).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });

  it("resolves a signal the next run no longer sees, and keeps the ones it does", async () => {
    await persistStaleRedSignals(
      db as never,
      [red(1), red(2), red(3)],
      new Date("2026-09-14T06:00:00Z")
    );
    expect(openKeys()).toEqual(["cpi:kpi:k1", "cpi:kpi:k2", "cpi:kpi:k3"]);

    await persistStaleRedSignals(db as never, [red(1), red(3)], new Date("2026-09-15T06:00:00Z"));
    expect(openKeys()).toEqual(["cpi:kpi:k1", "cpi:kpi:k3"]);
    const resolved = raw
      .prepare("SELECT resolved_at FROM stale_red_signals WHERE ref_key='cpi:kpi:k2'")
      .get() as {
      resolved_at: number;
    };
    expect(resolved.resolved_at).toBe(
      Math.floor(new Date("2026-09-15T06:00:00Z").getTime() / 1000)
    );
  });

  it("an empty run resolves everything, and a recurrence re-opens it", async () => {
    await persistStaleRedSignals(db as never, [red(1)], new Date("2026-09-14T06:00:00Z"));
    await persistStaleRedSignals(db as never, [], new Date("2026-09-15T06:00:00Z"));
    expect(openKeys()).toEqual([]);
    await persistStaleRedSignals(db as never, [red(1)], new Date("2026-09-16T06:00:00Z"));
    expect(openKeys()).toEqual(["cpi:kpi:k1"]);
  });
});
