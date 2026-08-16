/**
 * OPE-177 — the `undelivered_auth_email` queue's false-alarm guard.
 *
 * The risk this pins down: every ledger row written before the Cloudflare
 * Email Sending subscription existed has `delivery_status = NULL`, which means
 * "no signal", not "undelivered". A queue that treated NULL as a failure would
 * open at ~460 on its first run, be dismissed as noise, and be muted before it
 * ever carried a real bounce. So the window starts at the first delivery event
 * ever received, and these tests are the proof of that property rather than a
 * comment claiming it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { emailSendLedger, emailDeliveryEvents } from "../../db/schema";
import { undeliveredAuthEmailFlow } from "../queue-drain";

const SCHEMA_SQL = `
  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, recipient TEXT,
    source TEXT, provider_message_id TEXT, status TEXT NOT NULL DEFAULT 'sent',
    error TEXT, subject TEXT, inbound_email_id TEXT, provider TEXT,
    body_html TEXT, body_text TEXT,
    delivery_status TEXT, delivery_updated_at INTEGER, delivery_detail TEXT
  );
  CREATE TABLE email_delivery_events (
    event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, status TEXT NOT NULL,
    provider_message_id TEXT, recipient TEXT, sender TEXT, subject TEXT,
    terminal INTEGER, smtp_status_code TEXT, smtp_response TEXT,
    bounce_type TEXT, bounce_classification TEXT, event_timestamp INTEGER,
    received_at INTEGER NOT NULL, ledger_message_id TEXT
  );
`;

const NOW = new Date("2026-08-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeEach(() => {
  const raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

async function seedSend(
  messageId: string,
  source: string,
  sentAt: Date,
  deliveryStatus: string | null
) {
  await db.insert(emailSendLedger).values({
    messageId,
    sentAt,
    recipient: "someone@example.com",
    source,
    status: "sent",
    provider: "cf-email",
    deliveryStatus: deliveryStatus as never,
  });
}

async function seedFirstEvent(receivedAt: Date) {
  await db.insert(emailDeliveryEvents).values({
    eventId: `evt-${receivedAt.getTime()}`,
    eventType: "cf.email.sending.message.delivered",
    status: "delivered",
    receivedAt,
  });
}

describe("undelivered_auth_email queue", () => {
  it("reads 0 when no delivery event has ever arrived, even with old auth sends", async () => {
    // The pre-subscription world: three verification emails, all 'sent', none
    // with any delivery signal. This is exactly Heather's row shape.
    await seedSend("m1", "auth.register", hoursAgo(200), null);
    await seedSend("m2", "auth.send-verification", hoursAgo(199), null);
    await seedSend("m3", "auth.send-verification", hoursAgo(198), null);

    const row = await undeliveredAuthEmailFlow(db, NOW);
    expect(row.depth).toBe(0);
    expect(row.oldestOpenAgeHours).toBeNull();
  });

  it("counts a bounced auth send once events are flowing", async () => {
    await seedFirstEvent(hoursAgo(48));
    await seedSend("m4", "auth.register", hoursAgo(24), "bounced");

    const row = await undeliveredAuthEmailFlow(db, NOW);
    expect(row.depth).toBe(1);
    expect(row.inflow1d).toBe(1);
    expect(row.oldestOpenAgeHours).toBeCloseTo(24, 0);
  });

  it("ignores sends that predate the first delivery event", async () => {
    // A row from before the subscription cannot be judged — we had no signal
    // for it — so it stays out of the window regardless of its NULL status.
    await seedFirstEvent(hoursAgo(24));
    await seedSend("old", "auth.register", hoursAgo(400), null);
    await seedSend("new", "auth.register", hoursAgo(2), "bounced");

    const row = await undeliveredAuthEmailFlow(db, NOW);
    expect(row.depth).toBe(1);
  });

  it("does not count a deferral — that mail is still being retried", async () => {
    await seedFirstEvent(hoursAgo(48));
    await seedSend("m5", "auth.send-verification", hoursAgo(1), "deferred");
    await seedSend("m6", "auth.send-verification", hoursAgo(1), "delivered");

    expect((await undeliveredAuthEmailFlow(db, NOW)).depth).toBe(0);
  });

  it("counts only auth.* sources — a bounced newsletter is a different problem", async () => {
    await seedFirstEvent(hoursAgo(48));
    await seedSend("m7", "newsletter.subscribe-confirm", hoursAgo(3), "bounced");
    await seedSend("m8", "auth.register", hoursAgo(3), "bounced");

    expect((await undeliveredAuthEmailFlow(db, NOW)).depth).toBe(1);
  });

  it("reports no drain ratio — nothing drains these until the resend affordance exists", async () => {
    await seedFirstEvent(hoursAgo(48));
    await seedSend("m9", "auth.register", hoursAgo(3), "bounced");

    const row = await undeliveredAuthEmailFlow(db, NOW);
    expect(row.outflow7d).toBeNull();
    expect(row.drainRatio7d).toBeNull();
  });
});
