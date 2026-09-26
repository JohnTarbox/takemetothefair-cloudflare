/**
 * OPE-1163 — `thread-reply-ack` must not fire into a live human conversation.
 *
 * Classifier fixtures reproduce the SHAPES of the real thread-reply-ack
 * inbounds read from prod on 2026-09-26 (greeting, quote style, signature with
 * a phone number, Apple Mail `>` quoting), with names and numbers replaced.
 * The two that must stay NOT closing — a thanks carrying a request and a
 * thanks carrying a correction — are the reason the test abstains so hard.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import type Database from "better-sqlite3";
import {
  isConversationClosing,
  findRecentHumanReply,
  readThreadAckQuietHours,
  DEFAULT_THREAD_ACK_QUIET_HOURS,
  THREAD_ACK_QUIET_HOURS_KEY,
  decideThreadAckGuard,
} from "../src/email-handlers/thread-ack-suppression.js";
import type { Db } from "../src/db.js";

const GMAIL_QUOTE =
  "On Fri, Sep 25, 2026 at 11:04 AM Meet Me at the Fair <\nsupport@meetmeatthefair.com> wrote:\n\n> Hi,\n>\n> Call them on 802-555-0100 — the festival runs Saturday the 26th.\n";
const APPLE_QUOTE =
  "> On Sep 24, 2026, at 8:34 PM, Meet Me at the Fair <support@meetmeatthefair.com> wrote:\n> \n> Hi,\n> Their page confirms this year's dates: December 11–13, 2026.\n";

describe("isConversationClosing — closing specimens", () => {
  it.each([
    [
      "thanks + appreciation, signature with a phone after 'Best,' (Ashleigh shape)",
      `Hi John,\n\nThank you for the information and for getting back to me so quickly. I\nappreciate the help.\n\nBest,\nA Person\n\n\nA Person\nMobile: 555.010.0000\n\n${GMAIL_QUOTE}`,
    ],
    [
      "thanks + one pleasantry, bare name line, Apple `>` quote (Baldino shape)",
      `John,\n       Thank you for your informative response  .  I have loved your website , so glad I found it.\n\n Bruce\n\n\n\n${APPLE_QUOTE}`,
    ],
    [
      "a single thank-you sentence (woburnfire shape)",
      `Thank you very much, you went way above and beyond what I expected.\n\n${GMAIL_QUOTE}`,
    ],
  ])("%s → closing", (_l, body) => {
    expect(isConversationClosing(body)).toBe(true);
  });
});

describe("isConversationClosing — must NOT be closing (abstain toward a human)", () => {
  it.each([
    [
      "thanks + a request (Peter: 'Yes - please add us')",
      `Great information - thanks!\nYes - please add us to the directory - thanks --\n\n${GMAIL_QUOTE}`,
    ],
    [
      "thanks + a correction (Celina: 'I was talking about the Rhode Island one')",
      "Hi John,\n\nSorry about that! I was talking about the Rhode Island one!\n\nThank you!\n\nA Person\nSome Club\n",
    ],
    ["a question", "Thanks! Is the fair on Saturday or Sunday?"],
    ["new information with a date", "Thank you. The date was 9-19-26 at the Legion."],
    [
      "a link, even in a signature (Marge shape)",
      "Thank you so very much!\n\nhttp://www.example-art.com/Someone\n",
    ],
    [
      "thanks + several sentences of news",
      "Thank you so much. I'm rebuilding my website. I have not heard back from the organizer yet. Hoping soon!",
    ],
    ["a number with no other tell", "Thank you! Space 12 is ours."],
    ["no thanks at all", "Ok, got it."],
    ["empty sender text (only a quote)", GMAIL_QUOTE],
  ])("%s → not closing", (_l, body) => {
    expect(isConversationClosing(body)).toBe(false);
  });
});

let db: TestDb;
let raw: Database.Database;
beforeEach(() => {
  ({ db, raw } = createTestDb());
});

function inbound(
  id: string,
  threadId: string | null,
  receivedAt: number,
  from = "someone@example.com"
) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, thread_id)
       VALUES (?, ?, ?, ?, 'support@meetmeatthefair.com', 'support', ?)`
    )
    .run(id, receivedAt, receivedAt, from, threadId);
}
function sent(
  key: string,
  inboundId: string | null,
  sentAt: number,
  source: string,
  recipient: string | null = null,
  status = "sent"
) {
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, source, status, inbound_email_id, recipient) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(key, sentAt, source, status, inboundId, recipient);
}

const H = 3600;
const T0 = 1790350000;

describe("findRecentHumanReply", () => {
  it("finds a manual reply on the thread inside the window (juvanoire shape)", async () => {
    inbound("i1", "t1", T0 - 5 * H);
    sent("m1", "i1", T0 - 2 * H, "reply:manual");
    const r = await findRecentHumanReply(db as unknown as Db, {
      threadId: "t1",
      recipient: "someone@example.com",
      receivedAt: new Date(T0 * 1000),
      hours: 72,
    });
    expect(r).toEqual({
      source: "reply:manual",
      sentAt: new Date((T0 - 2 * H) * 1000).toISOString(),
    });
  });

  it("finds a manual reply to the same RECIPIENT on another thread (case-insensitive)", async () => {
    inbound("i2", "t-other", T0 - 10 * H);
    sent("m2", "i2", T0 - 3 * H, "reply:manual-gmail", "Someone@Example.com");
    const r = await findRecentHumanReply(db as unknown as Db, {
      threadId: "t1",
      recipient: "someone@example.com",
      receivedAt: new Date(T0 * 1000),
      hours: 72,
    });
    expect(r?.source).toBe("reply:manual-gmail");
  });

  it.each([
    ["older than the window", () => sent("x", "i3", T0 - 73 * H, "reply:manual")],
    ["an automated ack, not a person", () => sent("x", "i3", T0 - 1 * H, "reply:thread-reply-ack")],
    ["a failed manual send", () => sent("x", "i3", T0 - 1 * H, "reply:manual", null, "failed")],
    ["sent AFTER the message arrived", () => sent("x", "i3", T0 + 60, "reply:manual")],
  ])("ignores a send that is %s", async (_l, seed) => {
    inbound("i3", "t1", T0 - 80 * H);
    seed();
    const r = await findRecentHumanReply(db as unknown as Db, {
      threadId: "t1",
      recipient: "someone@example.com",
      receivedAt: new Date(T0 * 1000),
      hours: 72,
    });
    expect(r).toBeNull();
  });
});

describe("readThreadAckQuietHours", () => {
  it("defaults when the row is missing, and reads the row when present (tunable without a deploy)", async () => {
    expect(await readThreadAckQuietHours(db as unknown as Db)).toBe(DEFAULT_THREAD_ACK_QUIET_HOURS);
    raw
      .prepare(
        `INSERT INTO tunable_thresholds (key, value, unit, updated_at) VALUES (?, 24, 'hours', 0)`
      )
      .run(THREAD_ACK_QUIET_HOURS_KEY);
    expect(await readThreadAckQuietHours(db as unknown as Db)).toBe(24);
  });
});

// ── Replaying the three specimen threads (relative timings from prod) ──────
const OUR_MSG = "<WM2BaFWXZbYMzuE49OVee19YH7TUIpzpP2gg@meetmeatthefair.com>";

function replyRow(id: string, threadId: string, receivedAt: number, from: string, body: string) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, thread_id, in_reply_to, subject, body_text)
       VALUES (?, ?, ?, ?, 'support@meetmeatthefair.com', 'support', ?, ?, 'Re: your question', ?)`
    )
    .run(id, receivedAt, receivedAt, from, threadId, OUR_MSG, body);
}
const ledgerFor = (id: string) =>
  raw
    .prepare(
      `SELECT source, status, error FROM email_send_ledger WHERE inbound_email_id = ? AND message_id = ?`
    )
    .get(id, `reply-${id}`) as { source: string; status: string; error: string } | undefined;

describe("decideThreadAckGuard — specimen replays: zero thread acks, each with a reason", () => {
  it("Ashleigh: manual reply 53 min earlier, then a thank-you → closed-by-sender, ledgered, not sent", async () => {
    const body = `Hi John,\n\nThank you for the information and for getting back to me so quickly. I\nappreciate the help.\n\nBest,\nA Person\n\n\nA Person\nMobile: 555.010.0000\n\n${GMAIL_QUOTE}`;
    inbound("a0", "t-ash", 1790348000, "ashleigh@example.com");
    sent("a-m", "a0", 1790348660, "reply:manual", "ashleigh@example.com");
    replyRow("a1", "t-ash", 1790351838, "ashleigh@example.com", body);
    const closed = isConversationClosing(body);
    expect(closed).toBe(true);
    const g = await decideThreadAckGuard(db as unknown as Db, {
      messageRowId: "a1",
      replyKind: "support-ack",
      closedBySender: closed,
    });
    expect(g).toMatchObject({ reason: "closed-by-sender", kind: "thread-reply-ack" });
    expect(ledgerFor("a1")).toEqual({
      source: "reply:thread-reply-ack",
      status: "stubbed",
      error: "suppressed: closed-by-sender",
    });
  });

  it("Baldino: manual reply 1h54m earlier, then a thank-you → closed-by-sender", async () => {
    const body = `John,\n       Thank you for your informative response  .  I have loved your website , so glad I found it.\n\n Bruce\n\n\n\n${APPLE_QUOTE}`;
    inbound("b0", "t-bal", 1790296000, "bruce@example.com");
    sent("b-m", "b0", 1790296466, "reply:manual", "bruce@example.com");
    replyRow("b1", "t-bal", 1790303322, "bruce@example.com", body);
    const g = await decideThreadAckGuard(db as unknown as Db, {
      messageRowId: "b1",
      replyKind: "correction-ack",
      closedBySender: isConversationClosing(body),
    });
    expect(g.reason).toBe("closed-by-sender");
    expect(ledgerFor("b1")?.status).toBe("stubbed");
  });

  it("juvanoire: substantive reply 2h after a manual reply → recent-human-reply (not closing)", async () => {
    const body =
      "I realized I left one of your questions unanswered in my previous email.\n\nThe product is listed here:\nhttps://shop.example.com/listing/1\n\nBest,\nJ";
    inbound("j0", "t-juv", 1790310000, "juva@example.com");
    sent("j-m", "j0", 1790316195, "reply:manual", "juva@example.com");
    replyRow("j1", "t-juv", 1790323395, "juva@example.com", body);
    expect(isConversationClosing(body)).toBe(false);
    const g = await decideThreadAckGuard(db as unknown as Db, {
      messageRowId: "j1",
      replyKind: "support-ack",
      closedBySender: false,
    });
    expect(g.reason).toBe("recent-human-reply");
    expect(ledgerFor("j1")).toMatchObject({ status: "stubbed", source: "reply:thread-reply-ack" });
    expect(ledgerFor("j1")?.error).toMatch(
      /^suppressed: recent-human-reply \(reply:manual at .*, within 72h\)$/
    );
  });
});

describe("decideThreadAckGuard — regression: the ack still goes where it is useful", () => {
  it("a question on a thread whose last human reply is older than N → ack NOT suppressed", async () => {
    const body = "Thanks for the earlier note. When does the application window open?";
    inbound("q0", "t-q", T0 - 200 * H, "q@example.com");
    sent("q-m", "q0", T0 - 100 * H, "reply:manual", "q@example.com");
    replyRow("q1", "t-q", T0, "q@example.com", body);
    const g = await decideThreadAckGuard(db as unknown as Db, {
      messageRowId: "q1",
      replyKind: "support-ack",
      closedBySender: isConversationClosing(body),
    });
    expect(g).toEqual({ reason: null, kind: "thread-reply-ack", detail: null });
    expect(ledgerFor("q1")).toBeUndefined();
  });

  it("N is read from tunable_thresholds: a 1h setting lets the ack through at 2h", async () => {
    raw
      .prepare(
        `INSERT INTO tunable_thresholds (key, value, unit, updated_at) VALUES (?, 1, 'hours', 0)`
      )
      .run(THREAD_ACK_QUIET_HOURS_KEY);
    inbound("n0", "t-n", T0 - 10 * H, "n@example.com");
    sent("n-m", "n0", T0 - 2 * H, "reply:manual", "n@example.com");
    replyRow("n1", "t-n", T0, "n@example.com", "Here are the dates you asked for.");
    const g = await decideThreadAckGuard(db as unknown as Db, {
      messageRowId: "n1",
      replyKind: "support-ack",
      closedBySender: false,
    });
    expect(g.reason).toBeNull();
  });

  it("a non-thread ack (first contact) is never subject to recent-human-reply", async () => {
    raw
      .prepare(
        `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, thread_id) VALUES ('f1', ?, ?, 'f@example.com', 'support@meetmeatthefair.com', 'support', 't-f')`
      )
      .run(T0, T0);
    sent("f-m", null, T0 - 1 * H, "reply:manual", "f@example.com");
    const g = await decideThreadAckGuard(db as unknown as Db, {
      messageRowId: "f1",
      replyKind: "support-ack",
      closedBySender: false,
    });
    expect(g).toEqual({ reason: null, kind: "support-ack", detail: null });
  });
});

// ── Wiring (source-level, as owed-human-ope1018 / sent-reply-kind-ope1143) ──
import { readFileSync } from "node:fs";
const wf = readFileSync(new URL("../src/workflows/inbound-email.ts", import.meta.url), "utf8");

describe("workflow wiring", () => {
  it("the guard step runs BEFORE send-reply and suppresses it", () => {
    const guard = wf.indexOf('"reply-guard/thread-ack"');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(wf.indexOf('"send-reply"'));
    const tail = wf.slice(guard, wf.indexOf('"send-reply"'));
    expect(tail).toMatch(/suppressReply: true/);
  });

  it("a closing message is neither owed-human nor paused, and ends closed_by_sender", () => {
    expect(wf).toMatch(/const isOwedHuman = owedHuman\?\.owed === true && !closedBySender;/);
    expect(wf).toMatch(/!isOwedHuman &&\s*!closedBySender;/);
    expect(wf).toMatch(/closedBySender\s*\?\s*CLOSED_BY_SENDER_STATUS/);
  });

  it("the operator notice is told when the ack was withheld", () => {
    expect(wf).toMatch(
      /buildOwedHumanNotice\(messageRowId, intent, verdict, \{\s*ackSuppressed: threadAckSuppressed,/
    );
  });
});
