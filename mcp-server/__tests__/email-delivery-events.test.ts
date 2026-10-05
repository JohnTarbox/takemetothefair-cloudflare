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
  isFullMailbox,
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

/**
 * OPE-1317 — a full mailbox does not suppress (John, 2026-10-05). Cloudflare
 * labels every bounce `hard/permanent_failure`, so the label cannot decide it.
 * Both 552 strings below are verbatim from prod `email_delivery_events`: one is
 * a full mailbox, the other is a missing mailbox — the same SMTP code, which is
 * why the code alone must never decide.
 */
const OVER_QUOTA =
  "Permanent Unknown error: permanent error (552): 5.2.2 <someone@icloud.com>: user is over quota";
const NOT_FOUND_552 =
  "Permanent Unknown error: permanent error (552): 1 Requested mail action aborted, mailbox not found";
const NO_SUCH_USER_550 =
  "Permanent Unknown error: permanent error (550): 5.1.1 The email account that you tried to reach does not exist.";

describe("OPE-1317 — a full mailbox is not a reason to suppress", () => {
  it("isFullMailbox: the prod over-quota bounce, and the common wordings", () => {
    expect(isFullMailbox({ response: OVER_QUOTA })).toBe(true);
    expect(isFullMailbox({ enhancedStatusCode: "5.2.2" })).toBe(true);
    expect(isFullMailbox({ enhancedStatusCode: "4.2.2" })).toBe(true);
    expect(isFullMailbox({ response: "452 4.2.2 The email account is over quota" })).toBe(true);
    expect(isFullMailbox({ reason: "Mailbox full" })).toBe(true);
  });

  it("isFullMailbox: a bare 552, a missing mailbox, or nothing at all is NOT a full mailbox", () => {
    expect(isFullMailbox({ response: NOT_FOUND_552 })).toBe(false);
    expect(isFullMailbox({ response: NO_SUCH_USER_550 })).toBe(false);
    expect(isFullMailbox({ response: "552 5.3.4 Message size exceeds fixed limit" })).toBe(false);
    expect(isFullMailbox({})).toBe(false);
    expect(isFullMailbox()).toBe(false);
  });

  it("shouldSuppress: a 'hard' over-quota bounce does not suppress; a 'hard' missing mailbox still does", () => {
    expect(shouldSuppress("bounced", "hard", { response: OVER_QUOTA })).toBe(false);
    expect(shouldSuppress("bounced", "hard", { response: NOT_FOUND_552 })).toBe(true);
    expect(shouldSuppress("bounced", "hard", { response: NO_SUCH_USER_550 })).toBe(true);
    // A complaint is the person, not the mailbox — always suppresses.
    expect(shouldSuppress("complained", null, { response: OVER_QUOTA })).toBe(true);
  });

  it("end to end: the over-quota bounce event writes NO suppression row; the missing-mailbox one does", async () => {
    const bounce = (id: string, recipient: string, resp: string) => ({
      type: "cf.email.sending.message.bounced",
      source: { type: "email.sending", domain: "meetmeatthefair.com" },
      payload: {
        eventId: id,
        messageId: `<${id}@meetmeatthefair.com>`,
        recipient,
        delivery: { status: "bounced", smtpStatusCode: "552", smtpResponse: resp },
        bounce: { type: "hard", classification: "permanent_failure" },
      },
      metadata: { eventTimestamp: "2026-10-04T19:44:55.000Z", eventSchemaVersion: 1 },
    });
    await processDeliveryEvent(
      db,
      env,
      bounce("evt-full", "full@example.com", OVER_QUOTA) as never,
      "s1"
    );
    await processDeliveryEvent(
      db,
      env,
      bounce("evt-gone", "gone@example.com", NOT_FOUND_552) as never,
      "s1"
    );
    const suppressed = (await db.select().from(emailSuppressionList)).map((r) => r.email);
    expect(suppressed).toEqual(["gone@example.com"]);
    // The event itself is still recorded — not suppressing is not forgetting.
    expect(await db.select().from(emailDeliveryEvents)).toHaveLength(2);
  });
});
