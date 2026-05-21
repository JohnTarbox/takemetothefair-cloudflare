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
type MockEmailSendFn = (msg: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}) => Promise<void>;

function makeMockEnv(
  createFn: MockCreateFn,
  emailSendFn?: MockEmailSendFn
): {
  DB: D1Database;
  INBOUND_EMAIL: Workflow<{ messageRowId: string; intent: EmailIntent }>;
  EMAIL?: SendEmail;
} {
  return {
    // env.DB is only used by the sweep for logError side-channel writes.
    // The actual SELECT/UPDATE flows through the db arg passed separately
    // to runInboundEmailStaleSweep (a better-sqlite3 Drizzle instance).
    DB: raw as unknown as D1Database,
    INBOUND_EMAIL: {
      create: createFn,
    } as unknown as Workflow<{ messageRowId: string; intent: EmailIntent }>,
    ...(emailSendFn ? { EMAIL: { send: emailSendFn } as unknown as SendEmail } : {}),
  };
}

const INSERT_INBOUND_SQL = `INSERT INTO inbound_emails (
  id, received_at, from_address, to_address, intent, status,
  workflow_instance_id, attachment_count, recovery_attempt_n, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertInbound(opts: {
  id?: string;
  status?: string;
  workflowInstanceId?: string | null;
  receivedAtSecondsAgo?: number;
  intent?: EmailIntent;
  recoveryAttemptN?: number;
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
      opts.recoveryAttemptN ?? 0,
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

  // Pattern (B) — workflow errored mid-flight, row stuck in status='processing'
  // with workflow_instance_id NOT NULL. Added 2026-05-20 after the "Boxboro"
  // stuck row revealed that send-reply could throw past its retries and
  // exit the workflow before mark-done. Threshold is 15 min (vs 10 min for
  // pattern A) because the workflow DID start; we want extra confidence
  // before re-creating.
  it("picks up status='processing' rows older than 15 min (pattern B)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const stuckId = insertInbound({
      status: "processing",
      workflowInstanceId: "wf-original-errored",
      receivedAtSecondsAgo: 16 * 60, // 16 min ago — past 15-min threshold
    });
    const createFn = vi.fn(async () => ({ id: "wf-recovery-1" }));

    const result = await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(1);
    expect(result.recreatedCount).toBe(1);
    expect(createFn).toHaveBeenCalledWith({
      params: { messageRowId: stuckId, intent: "submit" },
      retention: { successRetention: "7 days", errorRetention: "7 days" },
    });

    // Back-link is OVERWRITTEN with the new instance id (the original
    // workflow still lives in the CF Workflows dashboard with
    // status=Errored, but the inbound row now points at the recovery).
    const row = raw
      .prepare("SELECT workflow_instance_id FROM inbound_emails WHERE id = ?")
      .get(stuckId) as { workflow_instance_id: string | null };
    expect(row.workflow_instance_id).toBe("wf-recovery-1");
  });

  it("skips status='processing' rows younger than 15 min (still in normal window)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    insertInbound({
      status: "processing",
      workflowInstanceId: "wf-still-running",
      receivedAtSecondsAgo: 5 * 60, // 5 min ago — too fresh
    });
    const createFn = vi.fn(async () => ({ id: "wf-recovery-1" }));

    const result = await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  it("skips status='processing' rows with NULL workflow_instance_id (ambiguous state)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    // status='processing' but workflow_instance_id IS NULL is a malformed
    // state: either the entrypoint's INSERT raced with the workflow's
    // mark-processing write OR a manual UPDATE went wrong. Either way,
    // unsafe to recover automatically — leave for admin review.
    insertInbound({
      status: "processing",
      workflowInstanceId: null,
      receivedAtSecondsAgo: 20 * 60,
    });
    const createFn = vi.fn(async () => ({ id: "wf-recovery-1" }));

    const result = await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    expect(result.foundCount).toBe(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  // Per-row recovery cap (drizzle/0082) — breaks the loop the existing
  // sweep docblock warned about ("if the original failure mode is
  // deterministic ... the same row will be picked up again next cycle").
  // Root incident: 2026-05-19 hamxposition.org NonRetryableError loop
  // (5 workflow runs before mark-done settled).
  it("increments recovery_attempt_n on each Pattern B recreate", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const id = insertInbound({
      status: "processing",
      workflowInstanceId: "wf-original",
      receivedAtSecondsAgo: 16 * 60,
      recoveryAttemptN: 0,
    });
    const createFn = vi.fn(async () => ({ id: "wf-recovery-1" }));

    await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    const row = raw
      .prepare("SELECT recovery_attempt_n FROM inbound_emails WHERE id = ?")
      .get(id) as { recovery_attempt_n: number };
    expect(row.recovery_attempt_n).toBe(1);
  });

  it("marks row terminally failed + sends sweep-exceeded reply once recovery_attempt_n hits the cap", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const id = insertInbound({
      status: "processing",
      workflowInstanceId: "wf-old",
      receivedAtSecondsAgo: 16 * 60,
      recoveryAttemptN: 3, // already at cap
    });
    const createFn = vi.fn(async () => ({ id: "wf-should-not-create" }));
    const emailSendFn = vi.fn(async () => {});

    const result = await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn, emailSendFn)
    );

    expect(result.foundCount).toBe(1);
    expect(result.exceededCount).toBe(1);
    expect(result.recreatedCount).toBe(0);
    expect(createFn).not.toHaveBeenCalled();

    const row = raw
      .prepare(
        "SELECT status, error, reply_kind, workflow_instance_id FROM inbound_emails WHERE id = ?"
      )
      .get(id) as {
      status: string;
      error: string | null;
      reply_kind: string | null;
      workflow_instance_id: string | null;
    };
    expect(row.status).toBe("failed");
    expect(row.reply_kind).toBe("sweep-exceeded");
    expect(row.error).toMatch(/sweep retry cap exceeded/);
    // workflow_instance_id is NOT overwritten — the cap path doesn't create
    // a new instance, so the old id stays for debugging in the CF dashboard.
    expect(row.workflow_instance_id).toBe("wf-old");

    // Sweep-exceeded auto-reply was sent.
    expect(emailSendFn).toHaveBeenCalledTimes(1);
    const call = emailSendFn.mock.calls[0][0];
    expect(call.to).toBe("alice@example.com");
    expect(call.subject).toMatch(/^Re:/);
  });

  it("still marks row terminally failed when EMAIL binding is absent (reply is best-effort)", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const id = insertInbound({
      status: "processing",
      workflowInstanceId: "wf-old",
      receivedAtSecondsAgo: 16 * 60,
      recoveryAttemptN: 3,
    });
    const createFn = vi.fn(async () => ({ id: "wf-should-not-create" }));

    // No emailSendFn passed → env.EMAIL is undefined; row should still
    // transition to failed, just without a reply going out.
    await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    const row = raw
      .prepare("SELECT status, reply_kind FROM inbound_emails WHERE id = ?")
      .get(id) as { status: string; reply_kind: string | null };
    expect(row.status).toBe("failed");
    expect(row.reply_kind).toBe("sweep-exceeded");
    expect(createFn).not.toHaveBeenCalled();
  });

  it("does not increment recovery_attempt_n when INBOUND_EMAIL.create throws", async () => {
    const { runInboundEmailStaleSweep } = await import("../src/inbound-email-stale-sweep.js");
    const id = insertInbound({
      status: "processing",
      workflowInstanceId: "wf-original",
      receivedAtSecondsAgo: 16 * 60,
      recoveryAttemptN: 0,
    });
    const createFn = vi.fn(async () => {
      throw new Error("simulated workflows quota error");
    });

    await runInboundEmailStaleSweep(
      db as unknown as Parameters<typeof runInboundEmailStaleSweep>[0],
      makeMockEnv(createFn)
    );

    // Counter stays at 0 — a Workflows-side quota failure shouldn't burn
    // through the per-row retry budget (the row would be unrecoverable
    // after 3 unrelated quota hits).
    const row = raw
      .prepare("SELECT recovery_attempt_n FROM inbound_emails WHERE id = ?")
      .get(id) as { recovery_attempt_n: number };
    expect(row.recovery_attempt_n).toBe(0);
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
