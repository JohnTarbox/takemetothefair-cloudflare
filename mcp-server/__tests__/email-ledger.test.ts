/**
 * OPE-151 — email_send_ledger as an audit log. Verifies the shared MCP mailer
 * choke point: one row per attempt, failures recorded, a later success upserts
 * 'sent' over an earlier 'failed', and dedup (wasEmailSent) counts only 'sent'.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger } from "../src/schema.js";
import { ledgerEmailSend, wasEmailSent } from "../src/mailer.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

describe("ledgerEmailSend / wasEmailSent (OPE-151)", () => {
  it("records a sent row with all audit columns", async () => {
    await ledgerEmailSend(db, {
      messageId: "m1",
      recipient: "carol@example.com",
      source: "reply:support-ack",
      subject: "Re: your inquiry",
      status: "sent",
      provider: "cf-email",
      providerMessageId: "cf-abc",
      inboundEmailId: "inb-1",
    });
    const [row] = await db
      .select()
      .from(emailSendLedger)
      .where(eq(emailSendLedger.messageId, "m1"));
    expect(row.status).toBe("sent");
    expect(row.recipient).toBe("carol@example.com");
    expect(row.source).toBe("reply:support-ack");
    expect(row.subject).toBe("Re: your inquiry");
    expect(row.provider).toBe("cf-email");
    expect(row.providerMessageId).toBe("cf-abc");
    expect(row.inboundEmailId).toBe("inb-1");
    expect(await wasEmailSent(db, "m1")).toBe(true);
  });

  it("a failed row is recorded but does NOT count as sent (retry not blocked)", async () => {
    await ledgerEmailSend(db, {
      messageId: "m2",
      recipient: "x@example.com",
      source: "reply:support-ack",
      status: "failed",
      error: "EMAIL.send 500",
    });
    const [row] = await db
      .select()
      .from(emailSendLedger)
      .where(eq(emailSendLedger.messageId, "m2"));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("EMAIL.send 500");
    expect(await wasEmailSent(db, "m2")).toBe(false); // retry must proceed
  });

  it("a later success upserts 'sent' over the earlier 'failed' (same id)", async () => {
    await ledgerEmailSend(db, { messageId: "m3", status: "failed", error: "transient" });
    expect(await wasEmailSent(db, "m3")).toBe(false);
    await ledgerEmailSend(db, {
      messageId: "m3",
      status: "sent",
      provider: "cf-email",
      providerMessageId: "cf-ok",
    });
    const rows = await db.select().from(emailSendLedger).where(eq(emailSendLedger.messageId, "m3"));
    expect(rows).toHaveLength(1); // upsert, not a second row
    expect(rows[0].status).toBe("sent");
    expect(rows[0].error).toBeNull();
    expect(await wasEmailSent(db, "m3")).toBe(true);
  });

  it("records a stubbed row (no provider configured)", async () => {
    await ledgerEmailSend(db, { messageId: "m4", status: "stubbed", provider: "stub" });
    const [row] = await db
      .select()
      .from(emailSendLedger)
      .where(eq(emailSendLedger.messageId, "m4"));
    expect(row.status).toBe("stubbed");
    expect(row.provider).toBe("stub");
    expect(await wasEmailSent(db, "m4")).toBe(false);
  });
});
