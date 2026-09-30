/**
 * OPE-1172 — a permanent send rejection is decided on the first attempt.
 *
 * AC1: a send to a suppressed address produces exactly ONE `env.EMAIL.send`
 * attempt, one `failed` ledger row carrying the error, no retry (so no DLQ
 * entry) and no `error`-level retry row. Same for "Invalid email address".
 * The LANDMARK is the transient case beside them: a timeout must still retry,
 * or "never retries" would pass on a consumer that has stopped retrying
 * anything at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger, emailDeliveryEvents } from "../src/schema.js";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
const logError = vi.fn();
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...a) }));

const { handleEmailBatch, isPermanentSendError } = await import("../src/queue-consumers.js");
const { processDeliveryEvent } = await import("../src/email-delivery.js");

const SUPPRESSED =
  "Cannot send emails to this recipient. This email address has been suppressed due to repeated bounces or because it reported your emails as spam";
const INVALID = "Invalid email address: Invalid email user";

beforeEach(() => {
  ({ db: harness.db } = createTestDb());
  logError.mockReset();
});

function run(sendError: string) {
  const send = vi.fn(async () => {
    throw new Error(sendError);
  });
  const msg = {
    id: "q-1",
    attempts: 1,
    body: {
      to: "typo@exmaple.com",
      subject: "Confirm your email",
      html: "<p>x</p>",
      text: "x",
      source: "auth.send-verification",
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const env = { DB: {} as D1Database, EMAIL: { send } };
  return {
    send,
    msg,
    done: handleEmailBatch({ messages: [msg] } as never, env as never),
  };
}

describe("OPE-1172 AC1 — permanent rejections are acked, not retried", () => {
  it.each([
    ["suppressed address", SUPPRESSED],
    ["invalid address", INVALID],
  ])("%s: one attempt, one failed ledger row, ack, no retry", async (_label, error) => {
    const { send, msg, done } = run(error);
    await done;

    expect(send).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled(); // no retry ⇒ never reaches the DLQ

    const rows = await harness.db.select().from(emailSendLedger);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toBe(error);

    // One warn marked permanent — not an error-level "will retry" row.
    const logged = logError.mock.calls.map((c) => c[1] as { level?: string; context?: object });
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe("warn");
    expect(logged[0].context).toMatchObject({ permanent: true });
  });

  it("LANDMARK: a transient failure still retries", async () => {
    const { msg, done } = run("Network connection lost");
    await done;
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe("isPermanentSendError — an explicit allow-list", () => {
  it("matches the stored provider wordings and our own no-recipient refusal", () => {
    expect(isPermanentSendError(SUPPRESSED)).toBe(true);
    expect(isPermanentSendError(INVALID)).toBe(true);
    expect(isPermanentSendError("no valid recipient in `to`")).toBe(true);
  });

  it("does not match anything else — unknown errors keep retrying", () => {
    for (const e of ["", null, undefined, "timeout", "Internal error", "rate limited"]) {
      expect(isPermanentSendError(e)).toBe(false);
    }
  });
});

describe("OPE-1172 scope 3 — a rejection event joins its failed row", () => {
  const rejected = (over: Record<string, unknown> = {}) => ({
    type: "cf.email.sending.message.rejected",
    payload: {
      eventId: "evt-r-1",
      messageId: "provider-id-we-never-saw",
      recipient: "Typo@Exmaple.com",
      ...over,
    },
    metadata: { eventTimestamp: "2026-09-26T22:36:02.000Z" },
  });

  async function seedFailed(id: string, sentAt: string, recipient = "typo@exmaple.com") {
    await harness.db.insert(emailSendLedger).values({
      messageId: id,
      sentAt: new Date(sentAt),
      recipient,
      source: "auth.send-verification",
      status: "failed",
      provider: "cf-email",
      providerMessageId: null,
      error: SUPPRESSED,
    });
  }

  it("attaches by recipient + window when the provider id cannot join", async () => {
    await seedFailed("a7e640ff", "2026-09-26T22:37:14Z");
    await processDeliveryEvent(harness.db, { DB: {} as D1Database }, rejected(), "s");

    const [ev] = await harness.db.select().from(emailDeliveryEvents);
    expect(ev.ledgerMessageId).toBe("a7e640ff");
    const [row] = await harness.db.select().from(emailSendLedger);
    expect(row.deliveryStatus).toBe("rejected");
  });

  it("does not attach outside the window, or to a different recipient", async () => {
    await seedFailed("too-old", "2026-09-26T20:00:00Z");
    await seedFailed("other", "2026-09-26T22:36:00Z", "someone@else.com");
    await processDeliveryEvent(harness.db, { DB: {} as D1Database }, rejected(), "s");

    const [ev] = await harness.db.select().from(emailDeliveryEvents);
    expect(ev.ledgerMessageId).toBeNull();
  });

  it("never applies the fallback to a non-rejected event", async () => {
    await seedFailed("a7e640ff", "2026-09-26T22:37:14Z");
    await processDeliveryEvent(
      harness.db,
      { DB: {} as D1Database },
      { ...rejected(), type: "cf.email.sending.message.bounced" },
      "s"
    );
    const [ev] = await harness.db.select().from(emailDeliveryEvents);
    expect(ev.ledgerMessageId).toBeNull();
  });
});
