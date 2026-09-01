/**
 * OPE-720 — a multi-intent email draws ONE reply, not one per routed child.
 *
 * The acceptance on the ticket is deliberately hard to fake: "a replay of
 * `c35b4919` produces exactly one outbound reply, not two." So the central test
 * is not "the leader is X" but **count the children that would send**, over the
 * real family shape read from the row table.
 *
 * The other thing under test is that the winner is chosen by a NAMED rank and
 * not by ordering. That is easy to ship green by accident — with two children,
 * "first row wins", "smallest id wins" and "highest rank wins" all agree half
 * the time. So every rank assertion below pins the id ordering AGAINST the rank
 * in one case and WITH it in another: an implementation that ignores
 * FANOUT_REPLY_RANK and sorts on id fails one of the pair whichever direction it
 * sorts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  pickFanoutReplyLeader,
  resolveFanoutReplyRole,
  FANOUT_REPLY_RANK,
} from "../src/email-handlers/fanout-reply-leader.js";
import type { Db } from "../src/db.js";
import { buildReply } from "../src/email-reply-builder.js";

type Raw = ReturnType<typeof createTestDb>["raw"];
let db: TestDb;
let raw: Raw;

const RECEIVED = new Date("2026-08-17T14:08:52Z");

function insertRow(id: string, intent: string, parentId: string | null) {
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, status, attachment_count, parent_email_id, created_at)
       VALUES (?, ?, 'ewelford@paradisecityarts.com', 'support@meetmeatthefair.com', 'Re: Incorrect Listing', ?, 'received', 0, ?, ?)`
    )
    .run(
      id,
      Math.floor(RECEIVED.getTime() / 1000),
      intent,
      parentId,
      Math.floor(RECEIVED.getTime() / 1000)
    );
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

describe("the family elects one spokesperson, by rank and not by ordering", () => {
  it("Emma's family (claim_request + correction) is answered by the correction child", () => {
    // `correction` (80) outranks `claim_request` (70) — and carries the LARGER
    // id, so an implementation that sorted on id ascending would pick the
    // claim_request child and fail here.
    const leader = pickFanoutReplyLeader([
      { id: "aaa-claim", intent: "claim_request" },
      { id: "zzz-correction", intent: "correction" },
    ]);
    expect(leader).toBe("zzz-correction");
  });

  it("the 05-21 family (claim_request + new_event) is answered by the new_event child", () => {
    // Same rank ordering, id ordering REVERSED: `new_event` (90) now carries the
    // SMALLER id. An implementation sorting on id descending fails here, and one
    // sorting ascending failed the case above. Only the rank satisfies both.
    const leader = pickFanoutReplyLeader([
      { id: "aaa-new-event", intent: "new_event" },
      { id: "zzz-claim", intent: "claim_request" },
    ]);
    expect(leader).toBe("aaa-new-event");
  });

  it("a consent change outranks an event submission", () => {
    // Answering an unsubscribe with "we created your event", and never
    // confirming the opt-out, is the one substitution with a compliance edge.
    expect(FANOUT_REPLY_RANK.unsubscribe).toBeGreaterThan(FANOUT_REPLY_RANK.new_event);
    expect(
      pickFanoutReplyLeader([
        { id: "aaa-new-event", intent: "new_event" },
        { id: "zzz-unsub", intent: "unsubscribe" },
      ])
    ).toBe("zzz-unsub");
  });

  it("two children with the SAME intent still elect exactly one — smallest id", () => {
    // Nothing in resolveRouting guarantees distinct intents: it maps the
    // classifier's `intents` one-to-one and filters only on confidence. Without
    // the id tie-break both rows out-rank nobody and both elect themselves,
    // which is the defect this module removes.
    expect(
      pickFanoutReplyLeader([
        { id: "bbb", intent: "correction" },
        { id: "aaa", intent: "correction" },
      ])
    ).toBe("aaa");
  });

  it("spam never speaks for a family it happens to be in", () => {
    expect(
      pickFanoutReplyLeader([
        { id: "aaa-spam", intent: "spam" },
        { id: "zzz-support", intent: "support" },
      ])
    ).toBe("zzz-support");
  });
});

describe("replaying Emma's cluster produces exactly ONE reply", () => {
  beforeEach(() => {
    insertRow("c35b4919", "multi", null);
    insertRow("d1ad3eee", "claim_request", "c35b4919");
    insertRow("95afd412", "correction", "c35b4919");
  });

  it("exactly one of the two children is the leader", async () => {
    const roles = await Promise.all(
      ["d1ad3eee", "95afd412"].map((id) => resolveFanoutReplyRole(db as unknown as Db, id))
    );
    const senders = roles.filter((r) => r === null || r.isLeader);
    expect(senders).toHaveLength(1);
  });

  it("the child that answers is the correction child, and it knows what else was asked", async () => {
    const role = await resolveFanoutReplyRole(db as unknown as Db, "95afd412");
    expect(role?.isLeader).toBe(true);
    expect(role?.otherIntents).toEqual(["claim_request"]);
  });

  it("the losing child is told to stay quiet", async () => {
    const role = await resolveFanoutReplyRole(db as unknown as Db, "d1ad3eee");
    expect(role?.isLeader).toBe(false);
  });

  it("the parent row is not a child and is unaffected", async () => {
    // The parent already sends nothing (0 sends against either parent in prod);
    // this fix must not turn it into a sender.
    expect(await resolveFanoutReplyRole(db as unknown as Db, "c35b4919")).toBeNull();
  });
});

describe("the single-intent path is untouched", () => {
  it("an ordinary inbound with no parent resolves to null, not to a role", async () => {
    // 416 of the 420 rows in prod are this shape. `null` is the caller's signal
    // to behave exactly as before, so a non-null answer here would put every
    // ordinary acknowledgement through new logic.
    insertRow("solo-row", "correction", null);
    expect(await resolveFanoutReplyRole(db as unknown as Db, "solo-row")).toBeNull();
  });

  it("a family that lost its siblings still answers rather than falling silent", async () => {
    // If a sibling INSERT aborted mid-family the survivor is alone. Suppressing
    // it would trade a duplicate reply for no reply, which is the worse failure
    // the ticket rules against.
    insertRow("lonely-parent", "multi", null);
    insertRow("lonely-child", "correction", "lonely-parent");
    expect(await resolveFanoutReplyRole(db as unknown as Db, "lonely-child")).toBeNull();
  });
});

describe("the one reply is correct for the WHOLE message", () => {
  it("names the other topic in plain English, not in routing vocabulary", () => {
    const msg = buildReply("correction-ack", "ewelford@paradisecityarts.com", {
      subject: "Incorrect Listing",
      fanoutOtherIntents: ["claim_request"],
    });
    expect(msg.text).toContain("a request to claim a listing");
    expect(msg.text).not.toContain("claim_request");
  });

  it("keeps the sign-off last", () => {
    const msg = buildReply("correction-ack", "a@b.com", {
      subject: "x",
      fanoutOtherIntents: ["claim_request"],
    });
    const noteIdx = msg.text.indexOf("covered more than one thing");
    const signOffIdx = msg.text.lastIndexOf("— Meet Me at the Fair");
    expect(noteIdx).toBeGreaterThan(-1);
    expect(signOffIdx).toBeGreaterThan(noteIdx);
  });

  it("says nothing at all when the message had one topic", () => {
    const msg = buildReply("correction-ack", "a@b.com", { subject: "x" });
    expect(msg.text).not.toContain("covered more than one thing");
  });

  it("omits triage-only intents rather than telling a sender we read them as spam", () => {
    const msg = buildReply("correction-ack", "a@b.com", {
      subject: "x",
      fanoutOtherIntents: ["spam", "unclear"],
    });
    expect(msg.text).not.toContain("covered more than one thing");
    expect(msg.text).not.toContain("spam");
  });
});
