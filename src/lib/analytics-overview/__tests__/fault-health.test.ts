/**
 * OPE-83 — render-fault health loader. Seeds an in-memory SQLite (the same
 * better-sqlite3 + drizzle pattern the other DB-backed loaders test with) and
 * asserts each KPI plus every null-guard: a cold ledger yields all-null ratios,
 * and a populated ledger yields the exact MTTD average, dedup rate, recurrence
 * rate, auto-detected share, and windowed server-message split.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import type { Db } from "../shared";
import { errorLogs, faultSignatures } from "../../db/schema";
import { loadRenderFaultHealth } from "../fault-health";

const SCHEMA_SQL = `
  CREATE TABLE fault_signatures (
    signature TEXT PRIMARY KEY,
    route TEXT,
    error_class TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    count INTEGER NOT NULL,
    status TEXT NOT NULL,
    ope_id TEXT,
    filed_at INTEGER,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'error',
    message TEXT NOT NULL,
    context TEXT DEFAULT '{}',
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

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 86_400_000;

let raw: InstanceType<typeof Database>;
let db: Db;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as Db;
});

function seedSig(over: {
  signature: string;
  status: "proposed" | "filed" | "done" | "regressed";
  count: number;
  opeId?: string | null;
  firstSeen?: Date;
  filedAt?: Date | null;
}) {
  return db.insert(faultSignatures).values({
    signature: over.signature,
    route: "/events/[slug]",
    errorClass: "boom",
    firstSeen: over.firstSeen ?? new Date(NOW - 10 * HOUR),
    lastSeen: new Date(NOW - HOUR),
    count: over.count,
    status: over.status,
    opeId: over.opeId ?? null,
    filedAt: over.filedAt ?? null,
    resolvedAt: null,
    createdAt: new Date(NOW - 20 * HOUR),
  });
}

function seedError(id: string, source: string, at: Date) {
  return db.insert(errorLogs).values({
    id,
    timestamp: at,
    message: "render error",
    source,
  });
}

describe("loadRenderFaultHealth", () => {
  it("returns all-null ratios for an empty ledger + no errors", async () => {
    const card = await loadRenderFaultHealth(db, 7);
    expect(card).toEqual({
      totalSignatures: 0,
      openSignatures: 0,
      autoDetectedPct: null,
      meanTimeToDetectHours: null,
      serverMessagePct: null,
      dedupCollapseRate: null,
      recurrenceRate: null,
      guardCoveragePct: null,
      windowDays: 7,
    });
  });

  it("computes every KPI from a populated ledger", async () => {
    await seedSig({ signature: "A", status: "proposed", count: 5, opeId: null });
    await seedSig({
      signature: "B",
      status: "filed",
      count: 3,
      opeId: "OPE-90",
      firstSeen: new Date(NOW - 10 * HOUR),
      filedAt: new Date(NOW - 8 * HOUR), // detect lag 2h
    });
    await seedSig({
      signature: "C",
      status: "filed",
      count: 2,
      opeId: "OPE-91",
      firstSeen: new Date(NOW - 20 * HOUR),
      filedAt: new Date(NOW - 14 * HOUR), // detect lag 6h
    });
    // done + regressed drive recurrenceRate; filedAt left null so they don't
    // perturb MTTD (which averages only rows that carry a filedAt stamp).
    await seedSig({ signature: "D", status: "done", count: 4, opeId: "OPE-80" });
    await seedSig({ signature: "E", status: "regressed", count: 6, opeId: "OPE-70" });

    // Windowed error split: 3 server-render + 1 client in-window; 1 server
    // out-of-window (10 days ago) must be excluded from the 7d denominator.
    await seedError("e1", "server-render", new Date(NOW - HOUR));
    await seedError("e2", "server-render", new Date(NOW - 2 * HOUR));
    await seedError("e3", "server-render", new Date(NOW - 3 * HOUR));
    await seedError("e4", "client", new Date(NOW - 4 * HOUR));
    await seedError("e5", "server-render", new Date(NOW - 10 * DAY));

    const card = await loadRenderFaultHealth(db, 7);

    expect(card.totalSignatures).toBe(5);
    // proposed(A) + filed(B,C) + regressed(E) = 4; done(D) excluded.
    expect(card.openSignatures).toBe(4);
    // ope_id set on B,C,D,E = 4/5.
    expect(card.autoDetectedPct).toBeCloseTo(0.8, 6);
    // avg(2h, 6h) = 4h.
    expect(card.meanTimeToDetectHours).toBeCloseTo(4, 6);
    // 3 server-render / 4 in-window rows.
    expect(card.serverMessagePct).toBeCloseTo(0.75, 6);
    // 1 - (5 distinct / 20 occurrences) = 0.75.
    expect(card.dedupCollapseRate).toBeCloseTo(0.75, 6);
    // regressed 1 / (done 1 + regressed 1) = 0.5.
    expect(card.recurrenceRate).toBeCloseTo(0.5, 6);
    // Not yet instrumented.
    expect(card.guardCoveragePct).toBeNull();
    expect(card.windowDays).toBe(7);
  });

  it("null-guards MTTD when no rows are filed, and recurrence when none done/regressed", async () => {
    await seedSig({ signature: "A", status: "proposed", count: 2, opeId: null });
    await seedSig({ signature: "B", status: "proposed", count: 2, opeId: null });

    const card = await loadRenderFaultHealth(db, 30);
    expect(card.totalSignatures).toBe(2);
    expect(card.meanTimeToDetectHours).toBeNull(); // no filedAt rows
    expect(card.recurrenceRate).toBeNull(); // no done/regressed
    expect(card.serverMessagePct).toBeNull(); // no error rows in window
    expect(card.autoDetectedPct).toBeCloseTo(0, 6); // 0 of 2 have ope_id
    // 1 - (2 distinct / 4 occurrences) = 0.5.
    expect(card.dedupCollapseRate).toBeCloseTo(0.5, 6);
  });
});
