/**
 * OPE-1609 — a withheld reply is recorded as withheld. Runs against the real
 * schema, because both halves are about what lands in D1.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  ledgerSuppressedReply,
  suppressedAckOutcome,
  ZERO_CONFIDENCE_UNCLEAR_REASON,
} from "../src/email-handlers/ack-suppression.js";
import { findRepliedWithoutLedger } from "../src/inbound/replied-without-ledger.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

const NOW = new Date("2026-11-10T15:00:00Z");
const minutesAgo = (m: number) => Math.floor((NOW.getTime() - m * 60_000) / 1000);

function inbound(id: string, opts: { status?: string; replyKind?: string | null; ago?: number }) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, status, reply_kind, raw_size, attachment_count, created_at)
       VALUES (?, ?, 'sender@example.org', 'hello@meetmeatthefair.com', 'Subject', 'support', ?, ?, 1, 0, ?)`
    )
    .run(
      id,
      minutesAgo(opts.ago ?? 30),
      opts.status ?? "replied",
      opts.replyKind === undefined ? "support-ack" : opts.replyKind,
      minutesAgo(opts.ago ?? 30)
    );
}

function ledger(id: string, inboundId: string, status: string) {
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, status, inbound_email_id) VALUES (?, ?, ?, ?)`
    )
    .run(id, minutesAgo(29), status, inboundId);
}

describe("suppressedAckOutcome", () => {
  const reason = ZERO_CONFIDENCE_UNCLEAR_REASON;

  it("a person with an open obligation reads as waiting, not answered", () => {
    expect(
      suppressedAckOutcome({
        replyKind: "support-ack",
        status: "replied",
        crossingDestinationRef: "support_obligation:52140af6",
        reason,
      })
    ).toEqual({
      replyKind: "support-ack-suppressed:classifier-unclear-zero-confidence",
      status: "awaiting_human",
    });
  });

  it("with no obligation it stops saying replied", () => {
    const out = suppressedAckOutcome({ replyKind: "unfetchable-url", status: "replied", reason });
    expect(out.status).toBe("forwarded");
    expect(out.replyKind).toBe("unfetchable-url-suppressed:classifier-unclear-zero-confidence");
  });

  it("a crossing that is not an obligation does not count as one", () => {
    expect(
      suppressedAckOutcome({
        replyKind: "ok",
        status: "replied",
        crossingDestinationRef: "event:abc",
        reason,
      }).status
    ).toBe("forwarded");
  });

  it("leaves a status that already is not replied alone", () => {
    expect(suppressedAckOutcome({ replyKind: "ok", status: "held", reason }).status).toBe("held");
  });
});

describe("ledgerSuppressedReply", () => {
  it("writes a stubbed row naming the reason and the recipient", async () => {
    inbound("a", {});
    await ledgerSuppressedReply(db, {
      messageRowId: "a",
      replyKind: "support-ack",
      reason: "fan-out-coalesced",
    });
    expect(
      raw
        .prepare(
          `SELECT status, source, error, recipient, inbound_email_id FROM email_send_ledger WHERE message_id = 'reply-a'`
        )
        .get()
    ).toEqual({
      status: "stubbed",
      source: "reply:support-ack",
      error: "suppressed: fan-out-coalesced",
      recipient: "sender@example.org",
      inbound_email_id: "a",
    });
  });

  it("never overwrites a real send", async () => {
    inbound("a", {});
    ledger("reply-a", "a", "sent");
    await ledgerSuppressedReply(db, {
      messageRowId: "a",
      replyKind: "support-ack",
      reason: "fan-out-coalesced",
    });
    expect(
      raw.prepare(`SELECT status FROM email_send_ledger WHERE message_id = 'reply-a'`).get()
    ).toEqual({ status: "sent" });
  });
});

describe("findRepliedWithoutLedger", () => {
  it("flags a replied row with no ledger row, and counts what it examined", async () => {
    inbound("missing", {});
    inbound("has-sent", {});
    ledger("reply-has-sent", "has-sent", "sent");
    inbound("has-stub", {});
    ledger("reply-has-stub", "has-stub", "stubbed");
    const out = await findRepliedWithoutLedger(db, NOW);
    expect(out.examined).toBe(3);
    expect(out.faults).toEqual([{ id: "missing", replyKind: "support-ack" }]);
  });

  it("ignores rows outside the window, human replies, and other statuses", async () => {
    inbound("too-young", { ago: 5 });
    inbound("too-old", { ago: 200 });
    inbound("manual", { replyKind: "manual" });
    inbound("external", { replyKind: "external" });
    inbound("no-kind", { replyKind: null });
    inbound("waiting", { status: "awaiting_human" });
    expect(await findRepliedWithoutLedger(db, NOW)).toEqual({ examined: 0, faults: [] });
  });
});

/**
 * Source-level, like sent-reply-kind-ope1143: the property is an ordering and a
 * data flow inside a Workflow, which the helpers above cannot show. Anchored on
 * call syntax, because a bare symbol also matches its import line.
 */
describe("workflow wiring", () => {
  const src = readFileSync(new URL("../src/workflows/inbound-email.ts", import.meta.url), "utf8");
  const guard = src.indexOf('"reply-guard/zero-confidence-unclear"');
  const ledgerStep = src.indexOf('"reply-guard/ledger-suppression"');
  const send = src.indexOf('"send-reply",');
  const markDone = src.indexOf('"mark-done",');

  it("records the reason at the zero-confidence guard", () => {
    expect(guard).toBeGreaterThan(-1);
    const block = src.slice(guard, ledgerStep);
    expect(block).toContain("replySuppressedReason = ZERO_CONFIDENCE_UNCLEAR_REASON;");
  });

  it("ledgers the suppression after every guard and before the send", () => {
    expect(ledgerStep).toBeGreaterThan(src.indexOf('"reply-guard/thread-ack"'));
    expect(ledgerStep).toBeLessThan(send);
    expect(src.slice(ledgerStep, send)).toContain(
      "ledgerSuppressedReply(getDb(this.env.DB), suppressed)"
    );
  });

  it("mark-done stores the recorded outcome, not the handler's", () => {
    const write = src.slice(
      markDone,
      src.indexOf(".where(eq(inboundEmails.id, messageRowId))", markDone)
    );
    expect(write).toContain(": recorded.status,");
    expect(write).toContain("replyKind: recorded.replyKind ?? null,");
    expect(write).not.toContain(": result.status,");
    expect(write).not.toContain("replyKind: result.replyKind ?? null,");
  });
});

describe("migration 0403", () => {
  const sqlText = readFileSync(
    new URL("../../drizzle/0403_ope1609_reply_truth.sql", import.meta.url),
    "utf8"
  );
  const ID = "7f761f2a-f179-47b9-aa98-42f63003cf03";
  const read = () =>
    raw.prepare(`SELECT status, reply_kind FROM inbound_emails WHERE id = ?`).get(ID);

  // heartbeat_probes is not in the shared test schema; only its seed row matters.
  beforeEach(() => {
    raw.exec(
      `CREATE TABLE heartbeat_probes (probe_name TEXT PRIMARY KEY, enabled_at INTEGER, note TEXT, updated_at INTEGER)`
    );
  });

  it("corrects the false row", () => {
    inbound(ID, {});
    raw.exec(sqlText);
    expect(read()).toEqual({
      status: "awaiting_human",
      reply_kind: "support-ack-suppressed:classifier-unclear-zero-confidence",
    });
  });

  it("leaves a row someone has since answered alone", () => {
    inbound(ID, { replyKind: "manual" });
    raw.exec(sqlText);
    expect(read()).toEqual({ status: "replied", reply_kind: "manual" });
  });

  it("is a no-op on an empty database and seeds the probe", () => {
    raw.exec(sqlText);
    expect(read()).toBeUndefined();
    expect(
      raw
        .prepare(`SELECT enabled_at IS NOT NULL armed FROM heartbeat_probes WHERE probe_name = ?`)
        .get("replied-ledger-check")
    ).toEqual({ armed: 1 });
  });
});
