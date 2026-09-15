/**
 * OPE-1018 — a reply to a question a PERSON asked is owed a person.
 *
 * The fixtures replay the two production threads exactly as they sit in
 * `inbound_emails` + `email_send_ledger` (read 2026-09-15), relative timings
 * included — the 4–7 s gap between a row's arrival and its own
 * `thread-reply-ack` is what a "latest send on the thread" rule would trip on.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./setup-db.js";
import type Database from "better-sqlite3";
import {
  decideOwedHuman,
  resolveOwedHuman,
  buildOwedHumanNotice,
  isHumanSendSource,
  OWED_HUMAN_STATUS,
  OWED_HUMAN_NOTICE_SOURCE,
} from "../src/email-handlers/owed-human.js";
import type { Db } from "../src/db.js";

const OUR_MSG = "<WM2BaFWXZbYMzuE49OVee19YH7TUIpzpP2gg@meetmeatthefair.com>";
const NEWSLETTER_MSG = "<abc123@mail.someothernewsletter.com>";

let db: TestDb;
let raw: Database.Database;

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

function inbound(
  id: string,
  threadId: string | null,
  receivedAt: number,
  inReplyTo: string | null
) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, thread_id, in_reply_to, subject, body_text_excerpt)
       VALUES (?, ?, ?, 'someone@example.com', 'support@meetmeatthefair.com', 'support', ?, ?, 'Re: your listing', 'Yes - please add us')`
    )
    .run(id, receivedAt, receivedAt, threadId, inReplyTo);
}
function sent(key: string, inboundId: string, sentAt: number, source: string, status = "sent") {
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, source, status, inbound_email_id) VALUES (?, ?, ?, ?, ?)`
    )
    .run(key, sentAt, source, status, inboundId);
}

describe("resolveOwedHuman — replaying the production threads", () => {
  it("Peter (57c3a91d): support-ack, then a manual reply, then his answer → OWED", async () => {
    // thread 4454a85c, epoch seconds as stored
    inbound("d3ccc095", "t-peter", 1789393957, null);
    sent("a1", "d3ccc095", 1789393962, "reply:support-ack");
    sent("a2", "d3ccc095", 1789404923, "reply:manual");
    inbound("57c3a91d", "t-peter", 1789405180, OUR_MSG);
    sent("a3", "57c3a91d", 1789405184, "reply:thread-reply-ack"); // his own ack, 4 s later

    const v = await resolveOwedHuman(db as unknown as Db, "57c3a91d");
    expect(v.owed).toBe(true);
    expect(v.previousSendSource).toBe("reply:manual");
    expect(v.previousSendAt).toBe(new Date(1789404923 * 1000).toISOString());
  });

  it("Becky (626d2c1c): the third message on her thread, after a manual reply → OWED", async () => {
    inbound("5592eaa2", "t-becky", 1789216305, null);
    sent("b1", "5592eaa2", 1789216310, "reply:support-ack");
    inbound("ad966eb7", "t-becky", 1789216465, OUR_MSG);
    sent("b2", "ad966eb7", 1789216470, "reply:thread-reply-ack");
    sent("b3", "ad966eb7", 1789313227, "reply:manual");
    inbound("626d2c1c", "t-becky", 1789415378, OUR_MSG);
    sent("b4", "626d2c1c", 1789415385, "reply:thread-reply-ack");

    expect((await resolveOwedHuman(db as unknown as Db, "626d2c1c")).owed).toBe(true);
  });

  it("Becky's SECOND message, 155 s after an automated support-ack → NOT owed (nobody asked it anything)", async () => {
    inbound("5592eaa2", "t-becky", 1789216305, null);
    sent("b1", "5592eaa2", 1789216310, "reply:support-ack");
    inbound("ad966eb7", "t-becky", 1789216465, OUR_MSG);
    sent("b2", "ad966eb7", 1789216470, "reply:thread-reply-ack");
    // The manual reply that came a day LATER must not count for this row.
    sent("b3", "ad966eb7", 1789313227, "reply:manual");

    const v = await resolveOwedHuman(db as unknown as Db, "ad966eb7");
    expect(v.owed).toBe(false);
    expect(v.previousSendSource).toBe("reply:support-ack");
  });

  it("a manual reply to an EARLIER message, sent after this one arrived, does not make this one owed", async () => {
    // The race the "sent before it arrived" bound exists for: the customer's
    // second email lands at T, John answers their FIRST email at T+30s (ledgered
    // against that earlier row), and this row's workflow evaluates afterwards.
    // Nobody had asked this message anything when it was written.
    inbound("r1", "t-race", 1789000000, null);
    sent("r-a", "r1", 1789000005, "reply:support-ack");
    inbound("r2", "t-race", 1789000500, OUR_MSG);
    sent("r-b", "r1", 1789000530, "reply:manual");

    const v = await resolveOwedHuman(db as unknown as Db, "r2");
    expect(v.owed).toBe(false);
    expect(v.previousSendSource).toBe("reply:support-ack");
  });

  it("a newsletter forward (in_reply_to names someone else's thread) after a manual send → NOT owed", async () => {
    inbound("n1", "t-news", 1789000000, null);
    sent("n-a", "n1", 1789000100, "reply:manual");
    inbound("n2", "t-news", 1789000500, NEWSLETTER_MSG);
    expect((await resolveOwedHuman(db as unknown as Db, "n2")).owed).toBe(false);
  });

  it("a manual reply that was only STUBBED (held, never delivered) does not count", async () => {
    inbound("s1", "t-stub", 1789000000, null);
    sent("s-a", "s1", 1789000100, "reply:manual", "stubbed");
    inbound("s2", "t-stub", 1789000500, OUR_MSG);
    expect((await resolveOwedHuman(db as unknown as Db, "s2")).owed).toBe(false);
  });

  it("a row with no thread_id (pre-OPE-768) is never owed, rather than guessed", async () => {
    inbound("u1", null, 1789000500, OUR_MSG);
    expect((await resolveOwedHuman(db as unknown as Db, "u1")).owed).toBe(false);
  });
});

describe("decideOwedHuman / isHumanSendSource", () => {
  it("counts both human send sources seen in the ledger, and nothing automated", () => {
    expect(isHumanSendSource("reply:manual")).toBe(true);
    expect(isHumanSendSource("reply:manual-gmail")).toBe(true);
    for (const s of ["reply:support-ack", "reply:thread-reply-ack", "reply:ok", null, undefined]) {
      expect(isHumanSendSource(s)).toBe(false);
    }
  });

  it("requires all three: a thread, a header naming us, a human previous send", () => {
    const base = {
      inReplyTo: OUR_MSG,
      emailReferences: null,
      threadId: "t",
      previousSendSource: "reply:manual",
    };
    expect(decideOwedHuman(base)).toBe(true);
    expect(decideOwedHuman({ ...base, threadId: null })).toBe(false);
    expect(decideOwedHuman({ ...base, inReplyTo: NEWSLETTER_MSG })).toBe(false);
    expect(decideOwedHuman({ ...base, previousSendSource: "reply:support-ack" })).toBe(false);
  });
});

describe("the operator notice", () => {
  it("is not a `reply:` source, so the customer-reply gate cannot hold it", () => {
    // The EMAIL_JOBS consumer holds `reply:*` while EMAIL_REPLY_ENABLED != 'true'.
    // If this notice were named `reply:…` it would be silently parked exactly
    // when John has customer replies switched off.
    expect(OWED_HUMAN_NOTICE_SOURCE.startsWith("reply:")).toBe(false);
  });

  it("names the row, the sender and how to answer", () => {
    const n = buildOwedHumanNotice("57c3a91d", "claim_request", {
      owed: true,
      threadId: "t-peter",
      previousSendSource: "reply:manual",
      previousSendAt: "2026-09-14T16:55:23.000Z",
      fromAddress: "plpescado@gmail.com",
      subject: "Re: listing",
      excerpt: "Yes - please add us to the directory",
      receivedAt: "2026-09-14T16:59:40.000Z",
    });
    expect(n.subject).toContain("plpescado@gmail.com");
    expect(n.text).toContain("57c3a91d");
    expect(n.text).toContain("Yes - please add us to the directory");
    expect(n.text).toContain("reply_to_inbound_email");
    expect(n.html).not.toContain("<script");
  });
});

describe("workflow wiring (source-level: the fix is an ordering and a gate)", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
    "utf8"
  );
  const at = (needle: string) => {
    const i = SRC.indexOf(needle);
    expect(i, `"${needle}" not found — this guard is inert, not passing`).toBeGreaterThan(-1);
    return i;
  };

  it("resolves owed-human BEFORE the admin-decision gate, and the gate excludes it", () => {
    expect(at('"thread/owed-human"')).toBeLessThan(at("const needsAdminDecision ="));
    const gate = SRC.slice(
      at("const needsAdminDecision ="),
      at("const needsAdminDecision =") + 300
    );
    expect(gate).toContain("!isOwedHuman");
  });

  it("mark-done writes the owed-human status, and the notice step sends on its source", () => {
    expect(SRC).toMatch(
      /status: caughtError \? "failed" : isOwedHuman \? OWED_HUMAN_STATUS : result\.status/
    );
    const notify = at('"notify/owed-human"');
    expect(notify).toBeGreaterThan(at('"mark-done"'));
    expect(SRC.slice(notify, notify + 1400)).toContain("source: OWED_HUMAN_NOTICE_SOURCE");
    expect(OWED_HUMAN_STATUS).toBe("awaiting_human");
  });
});
