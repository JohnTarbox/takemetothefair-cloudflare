/**
 * OPE-1251 — an operator can end a parked intake row without sending anything
 * (specimen: the Christmas Prelude "claim_request" child 198d0747, a demux
 * misread with no claim language).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { handleDismissInbound } from "../src/tools/admin-dismiss-inbound.js";
import { decisionDisposition } from "../src/workflows/inbound-email.js";
import { adminActions, emailSendLedger, inboundEmails } from "../src/schema.js";

let db: TestDb;
const sendEvent = vi.fn(async () => {});
const binding = { get: vi.fn(async () => ({ sendEvent })) };

function seed(status: string) {
  db.insert(inboundEmails)
    .values({
      id: "198d0747",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "prelude@example.org",
      toAddress: "notify@meetmeatthefair.com",
      subject: "Re: Kennebunkport Christmas Prelude 2026",
      intent: "claim_request",
      status,
      workflowInstanceId: "cf_99e6754a",
    } as never)
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  sendEvent.mockClear();
  binding.get.mockClear();
});

describe("handleDismissInbound", () => {
  it("dismisses a waiting row: audit row, a 'dismissed' decision delivered, status dismissed, nothing sent", async () => {
    seed("waiting");
    const r = await handleDismissInbound(
      db as never,
      binding,
      {
        inboundEmailId: "198d0747",
        reason: "demux misread: no claim language; John already replied by hand",
      },
      "u-admin"
    );
    expect(r.ok).toBe(true);
    expect(binding.get).toHaveBeenCalledWith("cf_99e6754a");
    expect(sendEvent).toHaveBeenCalledWith({
      type: "admin-decision",
      payload: { action: "dismissed", note: expect.stringContaining("demux misread") },
    });
    const [audit] = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "inbound.dismissed"))
      .all();
    expect(audit.targetId).toBe("198d0747");
    expect(db.select().from(inboundEmails).all()[0].status).toBe("dismissed");
    expect(db.select().from(emailSendLedger).all()).toHaveLength(0);
  });

  it("refuses a row that is not parked, and delivers nothing", async () => {
    seed("replied");
    const r = await handleDismissInbound(
      db as never,
      binding,
      { inboundEmailId: "198d0747", reason: "x" },
      null
    );
    expect(r).toMatchObject({ ok: false, reason: "not_waiting" });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(db.select().from(adminActions).all()).toHaveLength(0);
  });

  it("refuses an unknown row", async () => {
    const r = await handleDismissInbound(
      db as never,
      binding,
      { inboundEmailId: "nope", reason: "x" },
      null
    );
    expect(r).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("decisionDisposition — a dismissal never sends", () => {
  it("maps each outcome", () => {
    expect(decisionDisposition(null)).toBe("timeout");
    expect(decisionDisposition({ action: "dismissed" })).toBe("dismissed");
    expect(decisionDisposition({ action: "applied" })).toBe("reply");
    expect(decisionDisposition({ action: "rejected" })).toBe("reply");
  });
});
