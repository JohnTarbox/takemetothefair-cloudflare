/**
 * OPE-177 — the `unconfirmed_auth_email` queue.
 *
 * This queue only became buildable when delivery events arrived, and the first
 * week of them falsified the ticket's premise: `auth.register` measured 14
 * delivered against 1 bounced, so mail that never arrives is the rare case.
 * The population that matters is people whose verification mail landed and who
 * never clicked — invisible to the `undelivered_auth_email` queue by design.
 *
 * Three properties are load-bearing and are pinned here rather than asserted in
 * a comment: the self-gating window (no events => honest zero), the grace
 * period (a signup nine minutes old has not failed), and the case-insensitive
 * recipient join (a signal that quietly reads low is worse than no signal).
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { emailSendLedger, emailDeliveryEvents, users } from "../../db/schema";
import { unconfirmedAuthEmailFlow } from "../queue-drain";

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
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT,
    origin TEXT, name TEXT, role TEXT, email_verified INTEGER, image TEXT,
    oauth_provider TEXT, created_at INTEGER, updated_at INTEGER
  );
`;

const NOW = new Date("2026-08-23T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeEach(() => {
  const raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

async function seedUser(
  id: string,
  email: string,
  opts: { origin?: string; verifiedAt?: Date | null } = {}
) {
  await db.insert(users).values({
    id,
    email,
    origin: (opts.origin ?? "registration") as never,
    emailVerified: opts.verifiedAt ?? null,
  });
}

async function seedSend(
  messageId: string,
  recipient: string,
  sentAt: Date,
  deliveryStatus: string | null,
  source = "auth.register"
) {
  await db.insert(emailSendLedger).values({
    messageId,
    sentAt,
    recipient,
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

describe("unconfirmed_auth_email queue", () => {
  it("reads 0 when no delivery event has ever arrived", async () => {
    // Pre-subscription rows carry delivery_status NULL, which is "no signal".
    // Reporting them would open the queue at its historical backlog on day one.
    await seedUser("u1", "a@example.com");
    await seedSend("m1", "a@example.com", hoursAgo(200), null);

    const row = await unconfirmedAuthEmailFlow(db, NOW);
    expect(row.depth).toBe(0);
    expect(row.inflow7d).toBe(0);
    expect(row.drainRatio7d).toBeNull();
  });

  it("counts an unverified user whose auth mail was delivered before the grace expired", async () => {
    await seedFirstEvent(hoursAgo(300));
    await seedUser("u1", "a@example.com");
    await seedSend("m1", "a@example.com", hoursAgo(48), "delivered");

    const row = await unconfirmedAuthEmailFlow(db, NOW);
    expect(row.depth).toBe(1);
    expect(row.oldestOpenAgeHours).toBeCloseTo(48, 0);
  });

  it("does NOT count a signup still inside the 24h grace", async () => {
    // The property that keeps the tile credible: someone who registered nine
    // minutes ago has not failed to confirm anything.
    await seedFirstEvent(hoursAgo(300));
    await seedUser("u1", "fresh@example.com");
    await seedSend("m1", "fresh@example.com", hoursAgo(0.15), "delivered");

    const row = await unconfirmedAuthEmailFlow(db, NOW);
    expect(row.depth).toBe(0);
    // Still an arrival, though — inflow has no grace.
    expect(row.inflow1d).toBe(1);
  });

  it("does NOT count mail that bounced — that population belongs to the other queue", async () => {
    await seedFirstEvent(hoursAgo(300));
    await seedUser("u1", "bounced@example.com");
    await seedSend("m1", "bounced@example.com", hoursAgo(48), "bounced");

    expect((await unconfirmedAuthEmailFlow(db, NOW)).depth).toBe(0);
  });

  it("does NOT count ingestion placeholder accounts", async () => {
    // OPE-292 — `pending+<slug>@` owner rows are not registrations and never
    // verify; counting them would inflate this queue the way they inflate every
    // other user metric.
    await seedFirstEvent(hoursAgo(300));
    await seedUser("u1", "pending+someshow@meetmeatthefair.com", { origin: "ingestion" });
    await seedSend("m1", "pending+someshow@meetmeatthefair.com", hoursAgo(48), "delivered");

    expect((await unconfirmedAuthEmailFlow(db, NOW)).depth).toBe(0);
  });

  it("matches the recipient case-insensitively", async () => {
    // `users.email` preserves the casing a person typed; the ledger records what
    // was handed to the mailer. Exact equality would silently undercount.
    await seedFirstEvent(hoursAgo(300));
    await seedUser("u1", "Leavienessa@example.com");
    await seedSend("m1", "leavienessa@example.com", hoursAgo(48), "delivered");

    expect((await unconfirmedAuthEmailFlow(db, NOW)).depth).toBe(1);
  });

  it("reports the confirmation rate of delivered mail as drainRatio7d", async () => {
    await seedFirstEvent(hoursAgo(300));
    // Four arrivals in the window; one of them verified inside it.
    await seedUser("u1", "one@example.com", { verifiedAt: hoursAgo(30) });
    await seedSend("m1", "one@example.com", hoursAgo(36), "delivered");
    for (const n of [2, 3, 4]) {
      await seedUser(`u${n}`, `${n}@example.com`);
      await seedSend(`m${n}`, `${n}@example.com`, hoursAgo(36), "delivered");
    }

    const row = await unconfirmedAuthEmailFlow(db, NOW);
    expect(row.inflow7d).toBe(4);
    expect(row.outflow7d).toBe(1);
    expect(row.depth).toBe(3);
    expect(row.drainRatio7d).toBeCloseTo(0.25, 5);
  });

  it("ignores sends that predate the first delivery event", async () => {
    // The window starts at the first event, so a NULL-status historical row is
    // never retroactively indicted once the subscription goes live.
    await seedFirstEvent(hoursAgo(100));
    await seedUser("u1", "old@example.com");
    await seedSend("m1", "old@example.com", hoursAgo(200), "delivered");

    expect((await unconfirmedAuthEmailFlow(db, NOW)).depth).toBe(0);
  });
});
