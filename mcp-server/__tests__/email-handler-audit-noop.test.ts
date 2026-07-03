/**
 * OPE-74 — DB-shaped tests for the ingest-time audit-noop short-circuit.
 *
 * Mirrors the OPE-68 email-handler-attachments approach: the full
 * handleInboundEmail flow needs PostalMime + ForwardableEmailMessage + the
 * workflow binding mocked, so we test the extracted, exported `insertAuditNoopRow`
 * helper directly against a throwaway SQLite (createTestDb), which carries the
 * whole terminal-write contract. A companion test proves the salvage-candidate
 * predicate (the OPE-17 triage-queue count) excludes these rows.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { insertAuditNoopRow } from "../src/email-handler.js";
import { salvageCandidateWhere } from "../src/inbound-exception-notice.js";
import { inboundEmails } from "../src/schema.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

const NOTIFY = "notify@meetmeatthefair.com";
const REASON = "outbound-audit-copy-notify-at-meetmeatthefair";

describe("insertAuditNoopRow — terminal write", () => {
  it("writes a terminal audit-noop row that skips classification", async () => {
    await insertAuditNoopRow(db as never, {
      fromAddr: NOTIFY,
      toAddr: "submit@meetmeatthefair.com",
      subject: "We mentioned your fair on our blog",
      bodyTextExcerpt: "audit copy body",
      attachmentCount: 0,
      rawSize: 1234,
      messageId: "<audit-1@meetmeatthefair.com>",
      reason: REASON,
    });

    const rows = await db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.status).toBe("audit-noop");
    expect(r.intent).toBe("audit-noop");
    expect(r.flaggedForReview).toBe(0);
    expect(r.extractFailReason).toBe(REASON);
    expect(r.routingSource).toBe("audit_noop_sender");
    expect(r.fromAddress).toBe(NOTIFY);
    // No classification ran — every classifier column is null.
    expect(r.classifiedIntent).toBeNull();
    expect(r.classifiedConfidence).toBeNull();
    expect(r.classifierVersion).toBeNull();
    expect(r.classifiedAt).toBeNull();
    // Not routed anywhere.
    expect(r.workflowInstanceId).toBeNull();
    expect(r.routedToWorkflow).toBeNull();
  });

  it("is idempotent on redelivery (message_id dedup → one row)", async () => {
    const args = {
      fromAddr: NOTIFY,
      toAddr: "submit@meetmeatthefair.com",
      subject: "dup",
      bodyTextExcerpt: "",
      attachmentCount: 0,
      rawSize: 10,
      messageId: "<same@meetmeatthefair.com>",
      reason: REASON,
    };
    await insertAuditNoopRow(db as never, args);
    await insertAuditNoopRow(db as never, args); // redelivery — must not throw or duplicate
    const rows = await db.select().from(inboundEmails);
    expect(rows).toHaveLength(1);
  });
});

describe("salvage-candidate count — audit/system exclusion (OPE-17 triage queue)", () => {
  const base = {
    receivedAt: new Date(),
    toAddress: "submit@meetmeatthefair.com",
    status: "failed",
    intent: "submit",
    flaggedForReview: 0,
    attachmentCount: 0,
    createdAt: new Date(),
  };

  it("excludes a notify@ loopback even if it somehow reached status=failed/submit", async () => {
    // A normal salvage candidate — a real submitter whose extract failed.
    await db.insert(inboundEmails).values({
      ...base,
      id: "real-1",
      fromAddress: "jane@acme.com",
      messageId: null,
    });
    // A notify@ loopback that (hypothetically) leaked into the failed/submit bucket.
    await db.insert(inboundEmails).values({
      ...base,
      id: "notify-1",
      fromAddress: NOTIFY,
      messageId: null,
    });
    // Case-insensitive belt check: mixed-case notify address is still excluded.
    await db.insert(inboundEmails).values({
      ...base,
      id: "notify-2",
      fromAddress: "Notify@MeetMeAtTheFair.com",
      messageId: null,
    });

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(inboundEmails)
      .where(salvageCandidateWhere);
    expect(n).toBe(1); // only the real submitter counts

    // The audit-noop terminal rows are never salvage candidates either.
    await db.insert(inboundEmails).values({
      ...base,
      id: "noop-1",
      status: "audit-noop",
      intent: "audit-noop",
      fromAddress: NOTIFY,
      messageId: null,
    });
    const [{ n: n2 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(inboundEmails)
      .where(salvageCandidateWhere);
    expect(n2).toBe(1);
  });

  it("no-rescan: an existing audit-noop row matches neither salvage nor waiting predicates", async () => {
    await insertAuditNoopRow(db as never, {
      fromAddr: NOTIFY,
      toAddr: "submit@meetmeatthefair.com",
      subject: "x",
      bodyTextExcerpt: "",
      attachmentCount: 0,
      rawSize: 1,
      messageId: null,
      reason: REASON,
    });
    const salvage = await db
      .select({ id: inboundEmails.id })
      .from(inboundEmails)
      .where(salvageCandidateWhere);
    expect(salvage).toHaveLength(0);

    const waiting = await db
      .select({ id: inboundEmails.id })
      .from(inboundEmails)
      .where(
        and(
          eq(inboundEmails.status, "waiting"),
          isNull(inboundEmails.resultingEventId),
          inArray(inboundEmails.intent, ["correction", "claim_request", "submit", "new_event"])
        )
      );
    expect(waiting).toHaveLength(0);
  });
});
