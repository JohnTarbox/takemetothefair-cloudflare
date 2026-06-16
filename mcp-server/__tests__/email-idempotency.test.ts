import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger } from "../src/schema.js";
import { wasEmailSent, recordEmailSent, pruneEmailLedger } from "../src/queue-consumers.js";

// The email-jobs consumer dedups on the queue message id (stable across
// at-least-once redeliveries). These exercise the ledger helpers handleEmailBatch
// uses to skip an already-sent message on redelivery.
let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

describe("email idempotency ledger", () => {
  it("an unrecorded message id is not yet sent", async () => {
    expect(await wasEmailSent(db, "msg-1")).toBe(false);
  });

  it("recordEmailSent marks an id so a redelivery is detected", async () => {
    await recordEmailSent(db, {
      messageId: "msg-1",
      recipient: "a@example.com",
      source: "approval",
      providerMessageId: "p1",
    });
    expect(await wasEmailSent(db, "msg-1")).toBe(true);
    // A different message id is unaffected (no false dedup of distinct emails).
    expect(await wasEmailSent(db, "msg-2")).toBe(false);
  });

  it("recording the same id twice is idempotent (no throw, stays sent)", async () => {
    await recordEmailSent(db, {
      messageId: "dup",
      recipient: "a@example.com",
      source: "approval",
      providerMessageId: "p1",
    });
    // A racing/duplicate record must not throw on the PK conflict.
    await recordEmailSent(db, {
      messageId: "dup",
      recipient: "a@example.com",
      source: "approval",
      providerMessageId: "p2",
    });
    expect(await wasEmailSent(db, "dup")).toBe(true);
  });

  it("pruneEmailLedger drops rows past the TTL but keeps recent ones", async () => {
    const now = Date.UTC(2026, 5, 16, 12, 0, 0);
    await db.insert(emailSendLedger).values({
      messageId: "old",
      sentAt: new Date(now - 10 * 86_400_000), // 10 days old
      recipient: null,
      source: null,
      providerMessageId: null,
    });
    await db.insert(emailSendLedger).values({
      messageId: "recent",
      sentAt: new Date(now - 60_000), // 1 minute old
      recipient: null,
      source: null,
      providerMessageId: null,
    });

    await pruneEmailLedger(db, 3 * 86_400_000, now); // 3-day window

    expect(await wasEmailSent(db, "old")).toBe(false); // pruned
    expect(await wasEmailSent(db, "recent")).toBe(true); // kept
  });
});
