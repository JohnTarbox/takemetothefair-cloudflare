/**
 * OPE-163 — reply_to_inbound_email core (handleReplyToInbound). Verifies the
 * server-side reply: the OPE-6 disabled gate blocks all sends, the suppression
 * list is honored, a happy-path reply enqueues a threaded transactional job
 * (support@ From, In-Reply-To/References = inbound Message-ID, inbound_email_id
 * link) and marks the inbound status='replied'/reply_kind='manual', and a
 * missing inbound id is reported (not thrown).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { inboundEmails, emailSuppressionList, adminActions } from "../src/schema.js";
import { handleReplyToInbound } from "../src/tools/reply-to-inbound-email.js";
import { createTestDb, type TestDb } from "./setup-db.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

async function seedInbound(
  over: Partial<{ id: string; from: string; subject: string; messageId: string | null }> = {}
) {
  const id = over.id ?? "inb-1";
  await db.insert(inboundEmails).values({
    id,
    receivedAt: new Date(),
    fromAddress: over.from ?? "carol@example.com",
    toAddress: "submit@meetmeatthefair.com",
    subject: over.subject ?? "Trouble signing up",
    intent: "support",
    status: "received",
    messageId: over.messageId === undefined ? "<abc@mail.example.com>" : over.messageId,
    createdAt: new Date(),
  });
  return id;
}

interface SentJob {
  to: string;
  from?: string;
  subject: string;
  html: string;
  text: string;
  source: string;
  inboundEmailId?: string;
  inReplyTo?: string;
  references?: string;
}

/** A queue stub that records what got enqueued. */
function mockQueue() {
  const sent: SentJob[] = [];
  return {
    sent,
    binding: {
      send: vi.fn(async (m: SentJob) => {
        sent.push(m);
      }),
    },
  };
}

const enabled = (q: ReturnType<typeof mockQueue>) => ({
  emailJobs: q.binding,
  replyEnabled: true,
  actorUserId: "admin-1",
});

describe("handleReplyToInbound (OPE-163)", () => {
  it("refuses to send when the flag is disabled (nothing enqueued)", async () => {
    const id = await seedInbound();
    const q = mockQueue();
    const res = await handleReplyToInbound(
      db,
      { emailJobs: q.binding, replyEnabled: false, actorUserId: "admin-1" },
      { inboundEmailId: id, body: "Hi Carol" }
    );
    expect(res).toEqual({ ok: false, reason: "disabled", message: expect.any(String) });
    expect(q.sent).toHaveLength(0);
    const [row] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id));
    expect(row.status).toBe("received"); // untouched
  });

  it("honors the suppression list — sends nothing to an unsubscribed address", async () => {
    const id = await seedInbound({ from: "optout@example.com" });
    await db
      .insert(emailSuppressionList)
      .values({ email: "optout@example.com", reason: "unsubscribe", createdAt: new Date() });
    const q = mockQueue();
    const res = await handleReplyToInbound(db, enabled(q), { inboundEmailId: id, body: "hello" });
    expect(res).toMatchObject({ ok: false, reason: "suppressed" });
    expect(q.sent).toHaveLength(0);
  });

  it("enqueues a threaded transactional reply and marks the inbound replied", async () => {
    const id = await seedInbound();
    const q = mockQueue();
    const res = await handleReplyToInbound(db, enabled(q), {
      inboundEmailId: id,
      body: "Thanks for reaching out — try again now.",
    });
    expect(res).toMatchObject({
      ok: true,
      to: "carol@example.com",
      subject: "Re: Trouble signing up",
    });

    expect(q.sent).toHaveLength(1);
    const job = q.sent[0];
    expect(job.to).toBe("carol@example.com");
    expect(job.from).toContain("support@meetmeatthefair.com");
    expect(job.source).toBe("reply:manual");
    expect(job.inboundEmailId).toBe(id);
    // Threading from the inbound Message-ID.
    expect(job.inReplyTo).toBe("<abc@mail.example.com>");
    expect(job.references).toBe("<abc@mail.example.com>");
    // Plain transactional — HTML derived, no unsubscribe/marketing footer.
    expect(job.html).toContain("Thanks for reaching out");
    expect(job.html).not.toMatch(/unsubscribe/i);

    const [row] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id));
    expect(row.status).toBe("replied");
    expect(row.replyKind).toBe("manual");

    const actions = await db.select().from(adminActions).where(eq(adminActions.targetId, id));
    expect(actions.some((a) => a.action === "inbound.reply_sent")).toBe(true);
  });

  it("defaults the subject to Re: <original> but respects an explicit subject; omits threading when no Message-ID", async () => {
    const id = await seedInbound({ id: "inb-2", subject: "Question", messageId: null });
    const q = mockQueue();
    const res = await handleReplyToInbound(db, enabled(q), {
      inboundEmailId: id,
      subject: "Custom subject",
      body: "body",
    });
    expect(res).toMatchObject({ ok: true, subject: "Custom subject" });
    expect(q.sent[0].inReplyTo).toBeUndefined();
    expect(q.sent[0].references).toBeUndefined();
  });

  it("reports a missing inbound id without throwing", async () => {
    const q = mockQueue();
    const res = await handleReplyToInbound(db, enabled(q), { inboundEmailId: "nope", body: "x" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(q.sent).toHaveLength(0);
  });
});
