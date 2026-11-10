/**
 * OPE-1605 — the four gaps left by OPE-596: no exit from `approved`, approved
 * drafts invisible, no sent_message_id, and no BCC or footer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger, inboundEmails, operatorOutboundDrafts } from "../src/schema.js";
import { registerOperatorOutboundTools } from "../src/tools/admin-operator-outbound.js";
import { readOperatorQueues, totalWaiting } from "../src/operator-queue-notice.js";
import { handleEmailBatch } from "../src/queue-consumers.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
const T = new Date("2026-11-10T16:00:00Z");
const sent: Record<string, unknown>[] = [];

function tools(enabled = true) {
  const handlers = new Map<
    string,
    (a: never) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >();
  registerOperatorOutboundTools(
    {
      tool: (name: string, ...rest: unknown[]) =>
        handlers.set(name, rest[rest.length - 1] as never),
    } as never,
    db as never,
    { role: "ADMIN", userId: "admin-1" } as never,
    {
      OPERATOR_OUTBOUND_ENABLED: enabled ? "true" : "false",
      INTERNAL_API_KEY: "test-signing-key",
      MAILING_ADDRESS: "PO Box 1, Farmington ME",
      EMAIL_JOBS: { send: async (m: unknown) => void sent.push(m as Record<string, unknown>) },
    }
  );
  return handlers;
}
const call = async (name: string, args: Record<string, unknown>, enabled = true) => {
  const r = await tools(enabled).get(name)!(args as never);
  return { ...JSON.parse(r.content[0].text), isError: r.isError };
};

function draft(id: string, over: Partial<typeof operatorOutboundDrafts.$inferInsert> = {}) {
  db.insert(operatorOutboundDrafts)
    .values({
      id,
      toAddress: "karen@example.org",
      subject: "Your listing",
      bodyText: "A message about your listing.",
      reason: "the reason for sending this",
      composedAt: T,
      ...over,
    })
    .run();
}
const row = (id: string) =>
  db.select().from(operatorOutboundDrafts).where(eq(operatorOutboundDrafts.id, id)).all()[0];

beforeEach(() => {
  const t = createTestDb();
  db = t.db as unknown as TestDb;
  raw = t.raw;
  sent.length = 0;
});

describe("gap 1 — an exit from approved", () => {
  it("discards an approved, unsent draft with a note", async () => {
    draft("d1", { status: "approved" });
    const r = await call("review_operator_draft", {
      id: "d1",
      action: "discard",
      note: "duplicate of the 09-02 email",
    });
    expect(r.ok).toBe(true);
    expect(row("d1")).toMatchObject({
      status: "discarded",
      reviewNote: "duplicate of the 09-02 email",
    });
  });

  it("refuses without a note, and leaves the draft approved", async () => {
    draft("d1", { status: "approved" });
    const r = await call("review_operator_draft", { id: "d1", action: "discard", note: "  " });
    expect(r.error).toBe("note_required");
    expect(row("d1").status).toBe("approved");
  });

  it("refuses a draft that actually sent", async () => {
    draft("d1", { status: "approved", sentAt: T });
    expect(
      (await call("review_operator_draft", { id: "d1", action: "discard", note: "x" })).error
    ).toBe("already_reviewed");
  });

  it("still refuses to re-approve, which could send twice", async () => {
    draft("d1", { status: "approved" });
    expect((await call("review_operator_draft", { id: "d1", action: "approve" })).error).toBe(
      "already_reviewed"
    );
    expect(sent).toHaveLength(0);
  });
});

describe("gap 2 — approved drafts stay visible", () => {
  beforeEach(() => {
    draft("pending-1");
    draft("approved-unsent", { status: "approved" });
    draft("approved-sent", { status: "approved", sentAt: T });
    draft("sent-1", { status: "sent", sentAt: T });
    draft("discarded-1", { status: "discarded" });
  });

  it("the default view shows pending and approved-unsent only", async () => {
    const r = await call("list_operator_drafts", {});
    expect(r.drafts.map((d: { id: string }) => d.id).sort()).toEqual([
      "approved-unsent",
      "pending-1",
    ]);
  });

  it("an explicit status still means exactly that status", async () => {
    const r = await call("list_operator_drafts", { status: "approved" });
    expect(r.count).toBe(2);
  });

  it("the operator notice counts them on their own line", async () => {
    const c = await readOperatorQueues(db as never, T, {});
    expect(c.pendingOperatorDrafts).toBe(1);
    expect(c.approvedUnsentDrafts).toBe(1);
    expect(c.lines.join("\n")).toContain("1 approved operator draft(s) never sent");
    expect(totalWaiting(c)).toBeGreaterThanOrEqual(2);
  });
});

describe("gap 3 — sent_message_id", () => {
  it("the consumer writes the ledger id onto the draft once the send is accepted", async () => {
    draft("d1");
    await call("review_operator_draft", { id: "d1", action: "approve" });
    const primary = sent[0];
    expect(primary.operatorDraftId).toBe("d1");

    const acked: string[] = [];
    await handleEmailBatch(
      {
        messages: [
          {
            id: "ledger-msg-1",
            attempts: 1,
            body: primary,
            ack: () => acked.push("ledger-msg-1"),
            retry: () => {},
          },
        ],
      } as never,
      {
        DB: raw as never,
        EMAIL: { send: async () => ({ messageId: "provider-1" }) },
      } as never
    );

    expect(acked).toEqual(["ledger-msg-1"]);
    expect(row("d1").sentMessageId).toBe("ledger-msg-1");
    const [ledger] = db
      .select()
      .from(emailSendLedger)
      .where(eq(emailSendLedger.messageId, "ledger-msg-1"))
      .all();
    expect(ledger.status).toBe("sent");
  });

  it("a failed send leaves sent_message_id empty", async () => {
    draft("d1");
    await call("review_operator_draft", { id: "d1", action: "approve" });
    await handleEmailBatch(
      {
        messages: [{ id: "m2", attempts: 1, body: sent[0], ack: () => {}, retry: () => {} }],
      } as never,
      {
        DB: raw as never,
        EMAIL: {
          send: async () => {
            throw new Error("provider down");
          },
        },
      } as never
    );
    expect(row("d1").sentMessageId).toBeNull();
  });
});

describe("gap 4 — BCC and footer", () => {
  it("a composed message carries the footer in both parts, and John gets a copy", async () => {
    draft("d1");
    await call("review_operator_draft", { id: "d1", action: "approve" });
    expect(sent).toHaveLength(2);
    const [primary, copy] = sent;
    expect(primary).toMatchObject({ to: "karen@example.org", source: "operator:outbound" });
    expect(String(primary.text)).toContain("A message about your listing.");
    expect(String(primary.text)).toContain("Unsubscribe: https://meetmeatthefair.com/");
    expect(String(primary.text)).toContain("PO Box 1, Farmington ME");
    expect(String(primary.html)).toContain("Unsubscribe</a>");
    expect(copy).toMatchObject({
      to: "jtarboxme@gmail.com",
      subject: "[BCC] Your listing",
      source: "operator:outbound-bcc",
    });
    expect(String(copy.text)).toContain("karen@example.org");
    expect(copy.operatorDraftId).toBeUndefined();
    expect(copy.inboundEmailId).toBeUndefined();
  });

  it("a reply to someone who wrote to us carries no footer, and John still gets a copy", async () => {
    db.insert(inboundEmails)
      .values({
        id: "in1",
        receivedAt: T,
        createdAt: T,
        fromAddress: "karen@example.org",
        toAddress: "hello@meetmeatthefair.com",
        intent: "support",
        status: "replied",
        messageId: "<orig@mail>",
      } as typeof inboundEmails.$inferInsert)
      .run();
    draft("d1", { inboundEmailId: "in1" });
    await call("review_operator_draft", { id: "d1", action: "approve" });
    expect(sent[0].text).toBe("A message about your listing.");
    expect(sent[0].html).toBeUndefined();
    expect(sent[1].to).toBe("jtarboxme@gmail.com");
  });

  it("with delivery off, approving sends nothing at all", async () => {
    draft("d1");
    await call("review_operator_draft", { id: "d1", action: "approve" }, false);
    expect(sent).toHaveLength(0);
    expect(row("d1").status).toBe("approved");
  });
});
