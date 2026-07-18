/**
 * OPE-252 — canary self-hygiene: auto-decay of fixed-but-never-cleared canary
 * rows, and retry-once on the transient D1 blip that blinded the canary on
 * 2026-07-13. DB-backed (in-memory better-sqlite3, mirroring fault-health's
 * harness) so the actual decay SQL is exercised, not a mock of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import { pageErrorCanaryState, errorLogs } from "../src/schema.js";
import { __test } from "../src/page-error-canary.js";

const {
  isTransientD1Error,
  retryOnceOnTransientD1,
  decayStaleCanaryState,
  CANARY_STATE_DECAY_DAYS,
} = __test;

const SCHEMA_SQL = `
  CREATE TABLE page_error_canary_state (
    tier TEXT NOT NULL,
    source TEXT NOT NULL,
    last_alerted_at INTEGER NOT NULL,
    last_count INTEGER NOT NULL,
    PRIMARY KEY (tier, source)
  );
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    level TEXT,
    error TEXT,
    message TEXT,
    context TEXT,
    url TEXT,
    method TEXT,
    status_code INTEGER,
    stack_trace TEXT,
    user_agent TEXT,
    source TEXT,
    route TEXT,
    digest TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
const NOW = new Date("2026-07-18T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  db = drizzle(sqlite, { schema });
});

describe("isTransientD1Error (OPE-252)", () => {
  it("matches the 2026-07-13 shape + siblings, case-insensitive", () => {
    expect(isTransientD1Error(new Error("D1_ERROR: Network connection lost."))).toBe(true);
    expect(isTransientD1Error(new Error("internal error"))).toBe(true);
    expect(isTransientD1Error(new Error("connection reset by peer"))).toBe(true);
  });
  it("does NOT retry real query bugs", () => {
    expect(isTransientD1Error(new Error("no such column: foo"))).toBe(false);
    expect(isTransientD1Error(new Error("UNIQUE constraint failed"))).toBe(false);
  });
});

describe("retryOnceOnTransientD1 (OPE-252)", () => {
  it("retries once on a transient error and succeeds", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network connection lost"))
      .mockResolvedValueOnce("ok");
    const out = await retryOnceOnTransientD1(db, "test", "agg", op);
    expect(out).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });
  it("does not retry a non-transient error (fails fast, once)", async () => {
    const op = vi.fn().mockRejectedValue(new Error("no such column"));
    await expect(retryOnceOnTransientD1(db, "test", "agg", op)).rejects.toThrow("no such column");
    expect(op).toHaveBeenCalledTimes(1);
  });
  it("propagates a second transient failure (caller logs the error)", async () => {
    const op = vi.fn().mockRejectedValue(new Error("internal error"));
    await expect(retryOnceOnTransientD1(db, "test", "agg", op)).rejects.toThrow("internal error");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("decayStaleCanaryState (OPE-252)", () => {
  const SRC = "app/events/page.tsx:getEvents";

  it("decays a stale row whose source has had zero errors in the window", async () => {
    await db.insert(pageErrorCanaryState).values({
      tier: "YELLOW",
      source: SRC,
      lastAlertedAt: daysAgo(CANARY_STATE_DECAY_DAYS + 5),
      lastCount: 3,
    });
    await decayStaleCanaryState(db, "test", NOW);
    const rows = await db.select().from(pageErrorCanaryState);
    expect(rows).toHaveLength(0); // gone
  });

  it("KEEPS a stale row that is still erroring (fault not actually gone)", async () => {
    await db.insert(pageErrorCanaryState).values({
      tier: "YELLOW",
      source: SRC,
      lastAlertedAt: daysAgo(CANARY_STATE_DECAY_DAYS + 5),
      lastCount: 3,
    });
    await db.insert(errorLogs).values({
      id: "e1",
      timestamp: daysAgo(1), // recent error for the same source
      source: SRC,
      message: "boom",
    });
    await decayStaleCanaryState(db, "test", NOW);
    const rows = await db.select().from(pageErrorCanaryState);
    expect(rows).toHaveLength(1); // still red — kept
  });

  it("KEEPS a fresh row (not past the decay window)", async () => {
    await db.insert(pageErrorCanaryState).values({
      tier: "RED",
      source: SRC,
      lastAlertedAt: daysAgo(1),
      lastCount: 12,
    });
    await decayStaleCanaryState(db, "test", NOW);
    expect(await db.select().from(pageErrorCanaryState)).toHaveLength(1);
  });
});
