/**
 * OPE-1252 — a manual reply closes the waiting person's obligation only once
 * the send is CONFIRMED. Both live auto-closes had landed 7–8 s before their
 * ledger row, because the close ran on enqueue; a held, failed or rejected send
 * would have left the person marked `answered`. Drives the real email-jobs
 * consumer against SQLite.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger, inboundEmails, supportObligations } from "../src/schema.js";

const harness: { db: TestDb; raw: ReturnType<typeof createTestDb>["raw"] } = {
  db: null as unknown as TestDb,
  raw: null as never,
};
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn() }));
const { handleEmailBatch } = await import("../src/queue-consumers.js");

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const T = new Date("2026-09-30T21:00:00Z");
beforeEach(() => {
  ({ db: harness.db, raw: harness.raw } = createTestDb());
  harness.raw["exec"](ddlFor(supportObligations));
  harness.db
    .insert(inboundEmails)
    .values({
      id: "cb1e37f5",
      receivedAt: T,
      createdAt: T,
      fromAddress: "bruce@example.com",
      toAddress: "support@meetmeatthefair.com",
      subject: "Question about Portland Agricultural Fair 2026",
      intent: "support",
      status: "received",
      threadId: null,
      messageId: "<cb1e37f5@mail.example.com>",
    } as never)
    .run();
  harness.db
    .insert(supportObligations)
    .values({
      id: "c223027b",
      inboundEmailId: "cb1e37f5",
      fromAddress: "bruce@example.com",
      subject: "s",
      openedAt: T,
      status: "open",
    } as never)
    .run();
});

const statusOf = () =>
  harness.db
    .select()
    .from(supportObligations)
    .where(eq(supportObligations.id, "c223027b"))
    .all()[0];

function job(source = "reply:manual") {
  return {
    id: "ledger-msg-1",
    attempts: 1,
    body: {
      to: "bruce@example.com",
      subject: "Re: Question about Portland Agricultural Fair 2026",
      html: "<p>Parking is on Rand Rd.</p>",
      text: "Parking is on Rand Rd.",
      source,
      inboundEmailId: "cb1e37f5",
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function run(opts: {
  send: () => Promise<unknown>;
  replyEnabled?: boolean;
  source?: string;
}) {
  const m = job(opts.source);
  const env = {
    DB: {} as D1Database,
    EMAIL: { send: vi.fn(opts.send) },
    EMAIL_REPLY_ENABLED: opts.replyEnabled === false ? "false" : "true",
  };
  await handleEmailBatch({ messages: [m] } as never, env as never);
  return m;
}

describe("OPE-1252 — close on a confirmed send, never on a queued one", () => {
  it("a sent reply closes the obligation, after the ledger row, naming it", async () => {
    await run({ send: async () => ({ messageId: "prov-123" }) });
    const [row] = harness.db.select().from(emailSendLedger).all();
    expect(row.status).toBe("sent");
    const o = statusOf();
    expect(o.status).toBe("answered");
    expect(o.closeNote).toContain("email_send_ledger.message_id=ledger-msg-1");
    expect(o.closedAt!.getTime()).toBeGreaterThanOrEqual(row.sentAt!.getTime());
  });

  it("a permanently rejected (provider-suppressed) send leaves it OPEN", async () => {
    await run({
      send: async () => {
        throw new Error(
          "Cannot send emails to this recipient. This email address has been suppressed due to repeated bounces or because it reported your emails as spam"
        );
      },
    });
    expect(statusOf().status).toBe("open");
  });

  it("a transient failure (will retry) leaves it OPEN", async () => {
    const m = await run({
      send: async () => {
        throw new Error("upstream 503");
      },
    });
    expect(m.retry).toHaveBeenCalled();
    expect(statusOf().status).toBe("open");
  });

  it("a reply held by the reply gate (stubbed) leaves it OPEN", async () => {
    await run({ send: async () => ({ messageId: "x" }), replyEnabled: false });
    expect(statusOf().status).toBe("open");
  });

  it("a non-manual send to the same inbound closes nothing (only reply:manual answers)", async () => {
    await run({ send: async () => ({ messageId: "x" }), source: "reply:support-ack" });
    expect(statusOf().status).toBe("open");
  });
});
