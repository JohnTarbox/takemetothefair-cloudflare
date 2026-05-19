/**
 * Tests for the inbound_emails stale-row sweep.
 *
 * Real incident on 2026-05-19 (workflow da76901e, inbound row c6992b79)
 * showed that a D1 transient during the workflow's mark-processing step
 * could leave an inbound_emails row stuck in status='received' with no
 * auto-reply to the submitter. The sweep is the defense-in-depth that
 * catches those rows and re-creates the workflow.
 *
 * Tests exercise:
 *   - Row selection: only status='received' AND workflow_instance_id IS NULL
 *     AND received_at within [10min ago, 24h ago] is picked up
 *   - Per-row recovery: each match triggers INBOUND_EMAIL.create and the
 *     workflow_instance_id back-link is written
 *   - Idempotency: a second sweep skips rows the first one already
 *     recreated (because workflow_instance_id is now set)
 *   - Failure isolation: a create failure for row A doesn't block row B
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import type { EmailIntent } from "../src/email-intents.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];

beforeEach(() => {
  const setup = createTestDb();
  db = setup.db;
  raw = setup.raw;
});

interface MockWorkflowInstance {
  id: string;
}
type MockCreateFn = (params: {
  params: { messageRowId: string; intent: EmailIntent };
}) => Promise<MockWorkflowInstance>;

function makeMockEnv(createFn: MockCreateFn): {
  DB: D1Database;
  INBOUND_EMAIL: Workflow<{ messageRowId: string; intent: EmailIntent }>;
} {
  return {
    // env.DB is only used by the sweep for logError side-channel writes.
    // The actual SELECT/UPDATE flows through the db arg passed separately
    // to runInboundEmailStaleSweep (a better-sqlite3 Drizzle instance).
    DB: raw as unknown as D1Database,
    INBOUND_EMAIL: {
      create: createFn,
    } as unknown as Workflow<{ messageRowId: string; intent: EmailIntent }>,
  };
}

const INSERT_INBOUND_SQL = `INSERT INTO inbound_emails (
  id, received_at, from_address, to_address, intent, status,
  workflow_instance_id, attachment_count, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertInbound(opts: {
  id?: string;
  status?: string;
  workflowInstanceId?: string | null;
  receivedAtSecondsAgo?: number;
  intent?: EmailIntent;
}) {
  const id = opts.id ?? crypto.randomUUID();
  const receivedAtSec = Math.floor(Date.now() / 1000) - (opts.receivedAtSecondsAgo ?? 900);
  raw
    .prepare(INSERT_INBOUND_SQL)
    .run(
      id,
      receivedAtSec,
      "alice@example.com",
      "submit@meetmeatthefair.com",
      opts.intent ?? "submit",
      opts.status ?? "received",
      opts.workflowInstanceId ?? null,
      0,
      receivedAtSec
    );
  return id;
}

describe("runInboundEmailStaleSweep", () => {
  it("picks up status='received' rows older than 10 min with NULL workflow_instance_id", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const staleId = insertInbound({ receivedAtSecondsAgo: 900 }); // 15 min ago
    const createFn = vi.fn(async () => ({ id: "wf-new-1" }));

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(1);
    expect(result.recreatedCount).toBe(1);
    expect(result.createFailedCount).toBe(0);
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledWith({
      params: { messageRowId: staleId, intent: "submit" },
      retention: { successRetention: "7 days", errorRetention: "7 days" },
    });

    // Back-link is written.
    const row = raw
      .prepare("SELECT workflow_instance_id FROM inbound_emails WHERE id = ?")
      .get(staleId) as { workflow_instance_id: string | null };
    expect(row.workflow_instance_id).toBe("wf-new-1");
  });

  it("skips rows younger than 10 min (still in normal processing window)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    insertInbound({ receivedAtSecondsAgo: 60 }); // 1 min ago — too fresh
    const createFn = vi.fn(async () => ({ id: "wf-new-1" }));

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  it("skips rows older than 24h (caller has moved on)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    insertInbound({ receivedAtSecondsAgo: 25 * 3600 }); // 25h ago
    const createFn = vi.fn(async () => ({ id: "wf-new-1" }));

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  it("skips rows where workflow_instance_id is already set (idempotency)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    insertInbound({
      receivedAtSecondsAgo: 1200,
      workflowInstanceId: "wf-already-running",
    });
    const createFn = vi.fn(async () => ({ id: "wf-new-1" }));

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  it("skips rows in terminal/transient states (replied, failed, processing)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    insertInbound({ receivedAtSecondsAgo: 1200, status: "replied" });
    insertInbound({ receivedAtSecondsAgo: 1200, status: "failed" });
    insertInbound({ receivedAtSecondsAgo: 1200, status: "processing" });
    const createFn = vi.fn(async () => ({ id: "wf-new-1" }));

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  it("isolates create failure for one row from succeeding for another", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    insertInbound({ id: "row-good", receivedAtSecondsAgo: 1200 });
    insertInbound({ id: "row-bad", receivedAtSecondsAgo: 1200 });

    let callIdx = 0;
    const createFn = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) return { id: "wf-1" };
      throw new Error("simulated workflows quota error");
    });

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(2);
    expect(result.recreatedCount).toBe(1);
    expect(result.createFailedCount).toBe(1);
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it("returns per-row outcomes in the rows array (for admin endpoint)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const id1 = insertInbound({ receivedAtSecondsAgo: 1200 });
    const createFn = vi.fn(async () => ({ id: "wf-1" }));

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      messageRowId: id1,
      intent: "submit",
      outcome: "recreated",
      newWorkflowInstanceId: "wf-1",
    });
  });

  it("respects MAX_ROWS_PER_SWEEP cap to avoid quota saturation", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    for (let i = 0; i < 60; i++) {
      insertInbound({ receivedAtSecondsAgo: 1200 });
    }
    let n = 0;
    const createFn = vi.fn(async () => ({ id: `wf-${++n}` }));

    const result = await runInboundEmailStaleSweep(
      // better-sqlite3 Drizzle is structurally compatible with DrizzleD1Database
      // for the SELECT/UPDATE the sweep uses. Cast to satisfy nominal typing.
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(50);
    expect(createFn).toHaveBeenCalledTimes(50);
  });
});
