/**
 * OPE-1240 — John's ruling (2026-09-30): a reply to our OWN automatic
 * acknowledgment gets no automatic reply. The sender already holds a receipt
 * for this conversation; a second one is two robot emails for one exchange.
 *
 * Replies to automated NOTICES keep their ack (the recipient has no receipt),
 * and replies to a person keep `thread-reply-ack` (OPE-706).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { decideThreadAckGuard } from "../src/email-handlers/thread-ack-suppression.js";
import { isOwnAutomaticAck } from "../src/email-handlers/thread-reply-ack.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
const T = 1790500000;
const PARENT = "<parentFixture@meetmeatthefair.com>";

function parent(source: string) {
  raw["prepare"](
    "INSERT INTO email_send_ledger (message_id, sent_at, source, status, provider_message_id, recipient) VALUES (?, ?, ?, 'sent', ?, 'pat@example.com')"
  ).run(`p-${source}`, T - 3600, source, PARENT);
}
function reply(id: string) {
  raw["prepare"](
    `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, thread_id, in_reply_to, subject, body_text)
     VALUES (?, ?, ?, 'pat@example.com', 'support@meetmeatthefair.com', 'support', 't1', ?, 'Re: your message', 'Any update on my listing?')`
  ).run(id, T, T, PARENT);
}
const ledgerFor = (id: string) =>
  raw["prepare"]("SELECT status, error FROM email_send_ledger WHERE message_id = ?").get(
    `reply-${id}`
  ) as { status: string; error: string } | undefined;

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

describe("isOwnAutomaticAck", () => {
  it.each([
    ["reply:support-ack", true],
    ["reply:correction-ack", true],
    ["reply:manual", false],
    ["reply:manual-gmail", false],
    ["content-links-sync.promoter-mention", false],
    ["newsletter", false],
    [null, false],
  ] as const)("%s → %s", (src, expected) => expect(isOwnAutomaticAck(src)).toBe(expected));
});

describe("decideThreadAckGuard — reply to our own automatic ack", () => {
  it("a reply to our support-ack sends no ack: suppressed, ledgered 'stubbed' with the reason", async () => {
    parent("reply:support-ack");
    reply("r1");
    const g = await decideThreadAckGuard(db as never, {
      messageRowId: "r1",
      replyKind: "support-ack",
      closedBySender: false,
    });
    expect(g.reason).toBe("reply-to-own-ack");
    expect(ledgerFor("r1")).toMatchObject({
      status: "stubbed",
      error: expect.stringContaining("reply-to-own-ack"),
    });
  });

  it("a reply to an automated NOTICE keeps its ack (the Christmas Prelude case)", async () => {
    parent("content-links-sync.promoter-mention");
    reply("r2");
    const g = await decideThreadAckGuard(db as never, {
      messageRowId: "r2",
      replyKind: "correction-ack",
      closedBySender: false,
    });
    expect(g.reason).toBeNull();
    expect(g.kind).toBe("correction-ack");
    expect(ledgerFor("r2")).toBeUndefined();
  });

  it("a reply to a PERSON keeps thread-reply-ack (OPE-706 unchanged)", async () => {
    parent("reply:manual");
    reply("r3");
    raw["exec"]("DELETE FROM email_send_ledger"); // no recent-human-reply window hit…
    raw["prepare"](
      "INSERT INTO email_send_ledger (message_id, sent_at, source, status, provider_message_id, recipient) VALUES ('p-m', ?, 'reply:manual', 'sent', ?, 'someone-else@example.com')"
    ).run(T - 200 * 3600, PARENT); // …the manual parent is outside the 72h quiet window
    const g = await decideThreadAckGuard(db as never, {
      messageRowId: "r3",
      replyKind: "support-ack",
      closedBySender: false,
    });
    expect(g.kind).toBe("thread-reply-ack");
    expect(g.reason).not.toBe("reply-to-own-ack");
  });

  it("only generic acks are withheld — a real response to a reply still goes", async () => {
    parent("reply:support-ack");
    reply("r4");
    const g = await decideThreadAckGuard(db as never, {
      messageRowId: "r4",
      replyKind: "event-created" as never,
      closedBySender: false,
    });
    expect(g.reason).toBeNull();
  });
});
