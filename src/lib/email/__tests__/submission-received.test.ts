/**
 * OPE-412 — the submission receipt.
 *
 * Every acceptance criterion on this ticket is about NOT sending: no email
 * without an address, no five emails for five submissions, no turnaround claim
 * the queue cannot keep. So that is what these test — an ack that sends is easy,
 * and an ack that spams a good submitter or repeats a false promise is the
 * failure that would have to be un-sent.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { emailSendLedger, emailSuppressionList } from "../../db/schema";
import {
  sendSubmissionReceivedAck,
  buildSubmissionReceivedBody,
  SUBMISSION_RECEIVED_SOURCE,
} from "../submission-received";

const SCHEMA_SQL = `
  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, recipient TEXT,
    source TEXT, provider_message_id TEXT, status TEXT NOT NULL DEFAULT 'sent',
    error TEXT, subject TEXT, inbound_email_id TEXT, provider TEXT,
    body_html TEXT, body_text TEXT,
    delivery_status TEXT, delivery_updated_at INTEGER, delivery_detail TEXT
  );
  CREATE TABLE email_suppression_list (
    email TEXT PRIMARY KEY, reason TEXT, source TEXT, created_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
let queued: unknown[] = [];

const env = () => ({
  SUBMISSION_ACK_ENABLED: "true",
  EMAIL_JOBS: {
    send: async (m: unknown) => {
      queued.push(m);
    },
  } as unknown as Queue<unknown>,
});

const input = {
  toEmail: "submitter@example.com",
  eventName: "Northeast Egg & Art Expo 2026",
  eventId: "d2420720-b906-41ff-a272-d4e937742929",
  whenText: "August 22–24, 2026",
  whereText: "South Portland, ME",
};

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  queued = [];
});

describe("the copy", () => {
  it("makes NO turnaround promise — measured 0/6 within 48h", () => {
    // The form still says "24–48 hours" and the queue met it zero times out of
    // six. Repeating that in an email would take a claim the reader might have
    // skimmed on a page and deliver it to their inbox with our name on it.
    const { text } = buildSubmissionReceivedBody(input);
    expect(text).not.toMatch(/24[–-]48/);
    expect(text).not.toMatch(/\b(hours|days|weeks)\b/i);
  });

  it("quotes back what was actually submitted, so the receipt is checkable", () => {
    const { subject, text } = buildSubmissionReceivedBody(input);
    expect(subject).toContain("Northeast Egg & Art Expo 2026");
    expect(text).toContain("August 22–24, 2026");
    expect(text).toContain("South Portland, ME");
    expect(text).toContain("d2420720");
  });

  it("omits a date it does not have rather than inventing one", () => {
    const { text } = buildSubmissionReceivedBody({ ...input, whenText: null, whereText: null });
    expect(text).not.toContain("When:");
    expect(text).not.toContain("Where:");
    expect(text).toContain("Northeast Egg & Art Expo 2026");
  });

  it("says plainly that it is not published yet", () => {
    // The failure mode this prevents: a reader assuming "received" means "live",
    // then finding nothing on the site.
    expect(buildSubmissionReceivedBody(input).text).toMatch(/not published yet/i);
  });
});

describe("when NOT to send", () => {
  it("no email address → no send, no error", async () => {
    expect(await sendSubmissionReceivedAck(db, env(), { ...input, toEmail: null })).toBe(
      "skipped:no-email"
    );
    expect(queued).toHaveLength(0);
  });

  it("gate off → no send, and the reason is reported", async () => {
    const outcome = await sendSubmissionReceivedAck(
      db,
      { ...env(), SUBMISSION_ACK_ENABLED: "false" },
      input
    );
    expect(outcome).toBe("skipped:disabled");
    expect(queued).toHaveLength(0);
  });

  it("suppressed address → never mailed", async () => {
    await db.insert(emailSuppressionList).values({
      email: "submitter@example.com",
      reason: "unsubscribe",
      source: "unsubscribe-link",
      createdAt: new Date(),
    });
    expect(await sendSubmissionReceivedAck(db, env(), input)).toBe("skipped:suppressed");
    expect(queued).toHaveLength(0);
  });

  it("five submissions in five minutes produce ONE email", async () => {
    // The acceptance criterion, and the reason the cap is per ADDRESS rather
    // than per submission: someone entering three fairs in one sitting is a good
    // submitter, and thanking them three times reads as a malfunction.
    expect(await sendSubmissionReceivedAck(db, env(), input)).toBe("sent");
    // The ledger row the real consumer would write:
    await db.insert(emailSendLedger).values({
      messageId: "m1",
      sentAt: new Date(),
      recipient: "submitter@example.com",
      source: SUBMISSION_RECEIVED_SOURCE,
      status: "sent",
    });
    for (let i = 0; i < 4; i++) {
      expect(await sendSubmissionReceivedAck(db, env(), input)).toBe("skipped:rate-limited");
    }
    expect(queued).toHaveLength(1);
  });

  it("the cap is scoped to this source, not to all mail", async () => {
    // An unrelated email an hour ago must not silence a genuine receipt.
    await db.insert(emailSendLedger).values({
      messageId: "other",
      sentAt: new Date(),
      recipient: "submitter@example.com",
      source: "email:submission-approved",
      status: "sent",
    });
    expect(await sendSubmissionReceivedAck(db, env(), input)).toBe("sent");
  });

  it("an old ack does not block a new one", async () => {
    await db.insert(emailSendLedger).values({
      messageId: "old",
      sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
      recipient: "submitter@example.com",
      source: SUBMISSION_RECEIVED_SOURCE,
      status: "sent",
    });
    expect(await sendSubmissionReceivedAck(db, env(), input)).toBe("sent");
  });

  it("a different submitter is unaffected by someone else's cap", async () => {
    await db.insert(emailSendLedger).values({
      messageId: "theirs",
      sentAt: new Date(),
      recipient: "someone-else@example.com",
      source: SUBMISSION_RECEIVED_SOURCE,
      status: "sent",
    });
    expect(await sendSubmissionReceivedAck(db, env(), input)).toBe("sent");
  });

  it("normalizes the address so casing cannot dodge the cap or the suppression list", async () => {
    await db.insert(emailSuppressionList).values({
      email: "submitter@example.com",
      reason: "bounce",
      source: "cf-delivery-event",
      createdAt: new Date(),
    });
    expect(
      await sendSubmissionReceivedAck(db, env(), { ...input, toEmail: "  SubMitter@Example.COM " })
    ).toBe("skipped:suppressed");
  });
});

describe("sending", () => {
  it("queues exactly one message on the submission-received source", async () => {
    expect(await sendSubmissionReceivedAck(db, env(), input)).toBe("sent");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      to: "submitter@example.com",
      source: SUBMISSION_RECEIVED_SOURCE,
    });
  });

  it("reports rather than throws when the queue binding is missing", async () => {
    // A submission must succeed even when its receipt cannot be sent.
    const outcome = await sendSubmissionReceivedAck(db, { SUBMISSION_ACK_ENABLED: "true" }, input);
    expect(outcome).toBe("error:queue-missing");
  });
});
