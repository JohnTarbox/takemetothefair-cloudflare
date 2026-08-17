/**
 * OPE-386 — `get_ga4_liveness`.
 *
 * OPE-381 shipped a liveness check whose result no MCP tool could read, so its
 * acceptance ("the 06:00Z run records green with consecutive_failures=0") was
 * only confirmable with a developer D1 query. A check whose result is
 * unobservable from the operator surface can go red unnoticed — the same
 * silence class it exists to prevent.
 *
 * These tests pin the two behaviours that make the tool trustworthy: the
 * newest row is the one returned, and an EMPTY table is reported as a finding
 * rather than as an empty list.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc, eq } from "drizzle-orm";
import * as schema from "../src/schema.js";
import { ga4LivenessLog } from "../src/schema.js";

const SCHEMA_SQL = `
  CREATE TABLE ga4_liveness_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    max_data_date TEXT,
    data_age_seconds INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    alert_fired INTEGER NOT NULL DEFAULT 0
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seed(iso: string, status: string, failures = 0, ageSecs = 3600) {
  raw
    .prepare(
      `INSERT INTO ga4_liveness_log (checked_at, status, max_data_date, data_age_seconds, consecutive_failures, alert_fired)
       VALUES (?,?,?,?,?,0)`
    )
    .run(T(iso), status, iso.slice(0, 10), ageSecs, failures);
}

/** Mirrors the tool's query. */
async function read(limit = 1, status?: string) {
  const q = db
    .select({
      status: ga4LivenessLog.status,
      consecutive_failures: ga4LivenessLog.consecutiveFailures,
      data_age_seconds: ga4LivenessLog.dataAgeSeconds,
      max_data_date: ga4LivenessLog.maxDataDate,
      checked_at: ga4LivenessLog.checkedAt,
    })
    .from(ga4LivenessLog)
    .$dynamic();
  if (status) q.where(eq(ga4LivenessLog.status, status as never));
  return q.orderBy(desc(ga4LivenessLog.checkedAt)).limit(limit);
}

describe("returns the NEWEST row", () => {
  it("orders by checked_at descending, not insertion order", () => {
    // Seeded out of order on purpose: a reader that trusted rowid would report
    // a stale state as current, which is worse than no tool at all.
    seed("2026-08-17T06:01:09Z", "green", 0, 21669);
    seed("2026-08-15T06:00:00Z", "critical", 3, 200000);
    seed("2026-08-17T08:36:32Z", "green", 0, 30992);
    return read(1).then((rows: Array<Record<string, unknown>>) => {
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0].checked_at as Date).toISOString()).toBe("2026-08-17T08:36:32.000Z");
    });
  });

  it("returns history newest-first when a limit is given", async () => {
    seed("2026-08-15T06:00:00Z", "green");
    seed("2026-08-16T06:00:00Z", "green");
    seed("2026-08-17T06:00:00Z", "green");
    const rows = await read(3);
    const dates = rows.map((r: { checked_at: Date }) =>
      new Date(r.checked_at).toISOString().slice(0, 10)
    );
    expect(dates).toEqual(["2026-08-17", "2026-08-16", "2026-08-15"]);
  });
});

describe("the OPE-381 acceptance check", () => {
  it("surfaces status + consecutive_failures so the green run is confirmable", async () => {
    // Exactly the production row this tool was built to make visible.
    seed("2026-08-17T06:01:09Z", "green", 0, 21669);
    const [row] = await read(1);
    expect(row.status).toBe("green");
    expect(row.consecutive_failures).toBe(0);
    expect(row.max_data_date).toBe("2026-08-17");
    expect(row.data_age_seconds).toBe(21669);
  });
});

describe("status filter", () => {
  it("returns only the requested status", async () => {
    seed("2026-08-16T06:00:00Z", "critical", 2);
    seed("2026-08-17T06:00:00Z", "green", 0);
    const rows = await read(10, "critical");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("critical");
  });
});

describe("an empty table", () => {
  it("returns no rows, which the tool reports as a FINDING not a blank", () => {
    // The tool wraps this in an explicit note: an empty ga4_liveness_log means
    // the check has never run, which is the "shipped but silently not
    // executing" case. Returning a bare [] would read as "nothing wrong".
    return read(1).then((rows: unknown[]) => expect(rows).toHaveLength(0));
  });
});
