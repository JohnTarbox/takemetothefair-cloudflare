/**
 * OPE-177 — the delivery-event consumer.
 *
 * What these cover, and what they deliberately cannot: the matching key. We
 * store the RFC 5322 Message-ID the CF binding returns; the documented event
 * payload shows a bare id. `messageIdCandidates` exists because that ambiguity
 * is unresolved, and the tests below pin BOTH spellings — but a test cannot
 * prove which one Cloudflare actually sends. The unmatched-event path (and the
 * warn it logs) is the part that makes the real answer visible in production.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger, emailDeliveryEvents, emailSuppressionList } from "../src/schema.js";
import {
  processDeliveryEvent,
  messageIdCandidates,
  shouldSuppress,
  outranks,
  deliveryStatusOf,
  type EmailSendingEvent,
} from "../src/email-delivery.js";

let db: TestDb;
const env = { DB: null as unknown as D1Database };

beforeEach(async () => {
  ({ db } = createTestDb());
});

/** A real send, shaped exactly as prod stores it — angle-bracketed Message-ID. */
async function seedSend(messageId: string, providerMessageId: string, recipient: string) {
  await db.insert(emailSendLedger).values({
    messageId,
    sentAt: new Date("2026-08-16T12:00:00Z"),
    recipient,
    source: "auth.register",
    providerMessageId,
    status: "sent",
    provider: "cf-email",
  });
}

function event(over: Partial<NonNullable<EmailSendingEvent["payload"]>> = {}, type = "delivered") {
  return {
    type: `cf.email.sending.message.${type}`,
    source: { type: "email.sending", domain: "meetmeatthefair.com" },
    payload: {
      eventId: `evt-${type}-1`,
      messageId: "<abc123@meetmeatthefair.com>",
      sender: "notify@meetmeatthefair.com",
      recipient: "heather@example.com",
      subject: "Confirm your Meet Me at the Fair email",
      terminal: true,
      delivery: { status: type, smtpStatusCode: "250", smtpResponse: "250 2.0.0 OK" },
      ...over,
    },
    metadata: { eventTimestamp: "2026-08-16T12:00:05.000Z", eventSchemaVersion: 1 },
  } satisfies EmailSendingEvent;
}

describe("status derivation", () => {
  it("prefers the explicit delivery.status", () => {
    expect(deliveryStatusOf(event())).toBe("delivered");
  });

  it("falls back to the event type when delivery.status is absent", () => {
    const ev = event({ delivery: {} }, "bounced");
    expect(deliveryStatusOf(ev)).toBe("bounced");
  });

  it("returns null for an unrecognized shape rather than inventing a status", () => {
    expect(deliveryStatusOf({ type: "cf.email.sending.message.teleported" })).toBeNull();
  });
});

describe("messageIdCandidates", () => {
  it("matches whether or not the event wraps the id in angle brackets", () => {
    expect(messageIdCandidates("<a@b.com>")).toContain("a@b.com");
    expect(messageIdCandidates("a@b.com")).toContain("<a@b.com>");
  });

  it("is empty for a missing id, so no query runs on nothing", () => {
    expect(messageIdCandidates(null)).toEqual([]);
    expect(messageIdCandidates("  ")).toEqual([]);
  });
});

describe("suppression policy", () => {
  it("suppresses a hard bounce and a complaint", () => {
    expect(shouldSuppress("bounced", "hard")).toBe(true);
    expect(shouldSuppress("complained", null)).toBe(true);
  });

  it("does NOT suppress a soft bounce or a deferral", () => {
    // A full mailbox or a greylist is temporary. Suppressing on it would
    // silently blacklist a real user for a transient condition.
    expect(shouldSuppress("bounced", "soft")).toBe(false);
    expect(shouldSuppress("deferred", "soft")).toBe(false);
    expect(shouldSuppress("delivered", null)).toBe(false);
  });
});

describe("outranks — late events must not downgrade what we know", () => {
  it("anything beats no recorded status", () => {
    expect(outranks("deferred", null)).toBe(true);
  });

  it("a late deferred does not overwrite delivered", () => {
    expect(outranks("deferred", "delivered")).toBe(false);
  });

  it("a complaint outranks delivered (it necessarily happens after)", () => {
    expect(outranks("complained", "delivered")).toBe(true);
  });

  it("bounced outranks deferred", () => {
    expect(outranks("bounced", "deferred")).toBe(true);
  });
});

describe("processDeliveryEvent", () => {
  it("stores the event and folds delivery into the matched ledger row", async () => {
    await seedSend("q-1", "<abc123@meetmeatthefair.com>", "heather@example.com");
    await processDeliveryEvent(db, env, event(), "s1");

    const [evRow] = await db.select().from(emailDeliveryEvents);
    expect(evRow.status).toBe("delivered");
    expect(evRow.ledgerMessageId).toBe("q-1");

    const [ledger] = await db.select().from(emailSendLedger);
    expect(ledger.deliveryStatus).toBe("delivered");
    // The send-attempt status is untouched — the whole point of the separate
    // column. If this ever flips, wasEmailSent() starts re-sending real email.
    expect(ledger.status).toBe("sent");
  });

  it("matches when the event sends the BARE id and we stored the wrapped one", async () => {
    await seedSend("q-2", "<abc123@meetmeatthefair.com>", "heather@example.com");
    await processDeliveryEvent(db, env, event({ messageId: "abc123@meetmeatthefair.com" }), "s1");
    const [ledger] = await db.select().from(emailSendLedger);
    expect(ledger.deliveryStatus).toBe("delivered");
  });

  it("stores an UNMATCHED event rather than dropping it", async () => {
    // No ledger row seeded. This is the id-space-mismatch case, and it is the
    // one that must not fail silently.
    await processDeliveryEvent(db, env, event(), "s1");
    const [evRow] = await db.select().from(emailDeliveryEvents);
    expect(evRow.ledgerMessageId).toBeNull();
    expect(evRow.status).toBe("delivered");
  });

  it("is idempotent — a redelivered event does not double-apply", async () => {
    await seedSend("q-3", "<abc123@meetmeatthefair.com>", "bouncer@example.com");
    const bounced = {
      ...event({ bounce: { type: "hard", classification: "permanent_failure" } }, "bounced"),
    };
    await processDeliveryEvent(db, env, bounced, "s1");
    await processDeliveryEvent(db, env, bounced, "s1");

    expect(await db.select().from(emailDeliveryEvents)).toHaveLength(1);
    expect(await db.select().from(emailSuppressionList)).toHaveLength(1);
  });

  it("hard bounce suppresses the recipient; soft bounce does not", async () => {
    await seedSend("q-4", "<hard@meetmeatthefair.com>", "gone@example.com");
    await processDeliveryEvent(
      db,
      env,
      {
        ...event({
          eventId: "evt-hard",
          messageId: "<hard@meetmeatthefair.com>",
          recipient: "gone@example.com",
          bounce: { type: "hard", classification: "permanent_failure" },
        }),
        type: "cf.email.sending.message.bounced",
        payload: {
          eventId: "evt-hard",
          messageId: "<hard@meetmeatthefair.com>",
          recipient: "gone@example.com",
          delivery: { status: "bounced", smtpStatusCode: "550" },
          bounce: { type: "hard", classification: "permanent_failure" },
        },
      },
      "s1"
    );
    await processDeliveryEvent(
      db,
      env,
      {
        type: "cf.email.sending.message.bounced",
        payload: {
          eventId: "evt-soft",
          messageId: "<soft@meetmeatthefair.com>",
          recipient: "busy@example.com",
          delivery: { status: "bounced", smtpStatusCode: "452" },
          bounce: { type: "soft", classification: "temporary_failure" },
        },
      },
      "s1"
    );

    const suppressed = await db.select().from(emailSuppressionList);
    expect(suppressed.map((r) => r.email)).toEqual(["gone@example.com"]);
    expect(suppressed[0].reason).toBe("bounce");
  });

  it("suppression stores the address lowercased (the list is keyed lowercase)", async () => {
    await processDeliveryEvent(
      db,
      env,
      {
        type: "cf.email.sending.message.complained",
        payload: {
          eventId: "evt-c",
          messageId: "<c@meetmeatthefair.com>",
          recipient: "Loud.Complainer@Example.COM",
          delivery: { status: "complained" },
        },
      },
      "s1"
    );
    const [row] = await db.select().from(emailSuppressionList);
    expect(row.email).toBe("loud.complainer@example.com");
    expect(row.reason).toBe("complaint");
  });

  it("does not relabel an address the operator suppressed by hand", async () => {
    await db.insert(emailSuppressionList).values({
      email: "manual@example.com",
      reason: "manual",
      source: "admin",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await processDeliveryEvent(
      db,
      env,
      {
        type: "cf.email.sending.message.bounced",
        payload: {
          eventId: "evt-relabel",
          messageId: "<m@meetmeatthefair.com>",
          recipient: "manual@example.com",
          delivery: { status: "bounced" },
          bounce: { type: "hard" },
        },
      },
      "s1"
    );
    const [row] = await db.select().from(emailSuppressionList);
    expect(row.reason).toBe("manual");
    expect(row.source).toBe("admin");
  });

  it("a late deferred does not overwrite a recorded delivered on the ledger", async () => {
    await seedSend("q-5", "<order@meetmeatthefair.com>", "someone@example.com");
    await processDeliveryEvent(
      db,
      env,
      {
        type: "cf.email.sending.message.delivered",
        payload: {
          eventId: "evt-d",
          messageId: "<order@meetmeatthefair.com>",
          recipient: "someone@example.com",
          delivery: { status: "delivered" },
        },
      },
      "s1"
    );
    await processDeliveryEvent(
      db,
      env,
      {
        type: "cf.email.sending.message.deferred",
        payload: {
          eventId: "evt-df",
          messageId: "<order@meetmeatthefair.com>",
          recipient: "someone@example.com",
          delivery: { status: "deferred" },
        },
      },
      "s1"
    );
    const [ledger] = await db.select().from(emailSendLedger);
    expect(ledger.deliveryStatus).toBe("delivered");
  });
});
