/**
 * OPE-1214 — an organizer's reply to our AUTOMATED "your event was featured"
 * notice got `thread-reply-ack` ("attached to your existing thread … gone to
 * the person you've been corresponding with") plus "we also read it as a
 * request to claim a listing". All three claims were false.
 *
 * The fixture reproduces the specimen's SHAPE (paraphrased, not the
 * organizer's words): a schedule correction, a two-line Gmail attribution to
 * notify@, and our own notice quoted with `>` — including our event URL and
 * "visit your event page", the text the classifier mistook for a claim.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  classifyRepliedToSend,
  shouldUseThreadReplyAck,
} from "../src/email-handlers/thread-reply-ack.js";
import {
  dropInferredClaimSibling,
  hasExplicitClaimAsk,
  senderTextOfReply,
} from "../src/email-handlers/claim-ask.js";
import {
  DEFAULT_FANOUT_ACK_MENTION_MIN_CONFIDENCE,
  readFanoutAckMentionMinConfidence,
  resolveFanoutReplyRole,
} from "../src/email-handlers/fanout-reply-leader.js";
import { emailSendLedger, inboundEmails, tunableThresholds } from "../src/schema.js";

const NOTICE_ID = "<dP49NoticeFixture@meetmeatthefair.com>";
const MANUAL_ID = "<ManualReplyFixture@meetmeatthefair.com>";

const SPECIMEN = `Thanks for the mention! Our 2026 schedule is still being finalized and
what you have posted is from last year. The harbor festival is not happening
this year, and the dog parade now starts on a different street. Please keep
everything you have listed accurate.
Festival Team

On Sun, Sep 27, 2026 at 11:55 PM Meet Me at the Fair <
notify@meetmeatthefair.com> wrote:

> Meet Me at the Fair
> Your event was featured on our blog
>
> We just published a blog post that mentions your event *Holiday Festival 2026*.
>
> Feel free to share it — or visit your event page
> <https://meetmeatthefair.com/events/holiday-festival-2026>
> to see how it's being surfaced alongside related coverage.
`;

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

function ledger(id: string, source: string, providerMessageId: string) {
  db.insert(emailSendLedger)
    .values({
      messageId: id,
      sentAt: new Date(),
      source,
      providerMessageId,
      status: "sent",
    } as never)
    .run();
}

describe("the classifier reads only the sender's words on a reply to us", () => {
  const sender = senderTextOfReply(SPECIMEN);

  it("our quoted notice — its URL and 'visit your event page' — is gone", () => {
    expect(sender).toContain("harbor festival is not happening");
    expect(sender).not.toContain("meetmeatthefair.com/events");
    expect(sender).not.toContain("visit your event page");
    expect(sender).not.toMatch(/^\s*>/m);
  });

  it("a forward keeps its payload (the forward IS the submission)", () => {
    const fwd = `FYI\n\n---------- Forwarded message ---------\nFrom: Org <o@x.org>\n\nFair is June 5-7 at the grounds.`;
    expect(senderTextOfReply(fwd)).toContain("June 5-7");
  });

  it("a bottom-post keeps the sender's words (the attribution cut would leave nothing)", () => {
    const bottom = `On Mon, Sep 28, 2026 at 9 AM Us <notify@meetmeatthefair.com> wrote:\n> our text\nThe date is wrong, it is May 3.`;
    const out = senderTextOfReply(bottom);
    expect(out).toContain("The date is wrong, it is May 3.");
    expect(out).not.toContain("our text");
  });

  it("a reply that is ALL quote is left whole rather than emptied", () => {
    const allQuote = `> Meet Me at the Fair\n> Your event was featured on our blog`;
    expect(senderTextOfReply(allQuote)).toBe(allQuote);
  });
});

describe("a claim needs an explicit ask", () => {
  it("the specimen's own words carry none", () => {
    expect(hasExplicitClaimAsk(senderTextOfReply(SPECIMEN))).toBe(false);
  });

  it.each([
    "How do I claim my listing?",
    "Can we manage our listing ourselves?",
    "I'd like to log in and fix it.",
    "Please give me access to the listing.",
    "Can I take over this page?",
  ])("counts: %s", (text) => expect(hasExplicitClaimAsk(text)).toBe(true));

  it.each(["We manage parking on Main St.", "Please update the dates.", "Our fair is great"])(
    "does not count: %s",
    (text) => expect(hasExplicitClaimAsk(text)).toBe(false)
  );

  it("computeRouting feeds the classifier the stripped text and applies the guard (wiring)", () => {
    const src = readFileSync(join(__dirname, "../src/email-handler.ts"), "utf8");
    expect(src).toMatch(/replyChainHeader \? senderTextOfReply\(bodyText\) : bodyText/);
    expect(src).toMatch(/classifyIntent\(env\.AI, \{[\s\S]{0,300}?bodyText: classifierBody,/);
    expect(src).toMatch(/dropInferredClaimSibling\(rawResult\.intents, classifierBody\)/);
  });

  it("an inferred claim SIBLING is dropped; the correction stays", () => {
    const r = dropInferredClaimSibling(
      [{ intent: "correction" }, { intent: "claim_request" }],
      senderTextOfReply(SPECIMEN)
    );
    expect(r.dropped).toBe(true);
    expect(r.intents.map((c) => c.intent)).toEqual(["correction"]);
  });

  it("an explicit ask keeps the claim sibling (the guard only removes)", () => {
    const r = dropInferredClaimSibling(
      [{ intent: "correction" }, { intent: "claim_request" }],
      "The date is wrong. Also, how do I claim my listing?"
    );
    expect(r.dropped).toBe(false);
    expect(r.intents).toHaveLength(2);
  });

  it("a message whose ONLY reading is a claim is left to the model", () => {
    expect(dropInferredClaimSibling([{ intent: "claim_request" }], "hello there").dropped).toBe(
      false
    );
  });
});

describe("thread-reply-ack only for a reply to a PERSON", () => {
  it("a reply to the automated notice is 'automated' → no thread-reply-ack", async () => {
    ledger("m1", "content-links-sync.promoter-mention", NOTICE_ID);
    const repliedTo = await classifyRepliedToSend(db as never, NOTICE_ID, null);
    expect(repliedTo).toBe("automated");
    expect(shouldUseThreadReplyAck("correction-ack", NOTICE_ID, null, repliedTo)).toBe(false);
  });

  it("a reply to a manual reply is 'human' → thread-reply-ack (OPE-706 unchanged)", async () => {
    ledger("m2", "reply:manual", MANUAL_ID);
    const repliedTo = await classifyRepliedToSend(db as never, MANUAL_ID, null);
    expect(repliedTo).toBe("human");
    expect(shouldUseThreadReplyAck("support-ack", MANUAL_ID, null, repliedTo)).toBe(true);
  });

  it("the ledger is matched without an inbound row (the notice has none)", async () => {
    ledger("m3", "reply:manual-gmail", MANUAL_ID);
    expect(await classifyRepliedToSend(db as never, null, `<a@x> ${MANUAL_ID}`)).toBe("human");
  });

  it("our domain but no ledger row is 'unknown' → no thread-reply-ack", async () => {
    const repliedTo = await classifyRepliedToSend(
      db as never,
      "<nowhere@meetmeatthefair.com>",
      null
    );
    expect(repliedTo).toBe("unknown");
    expect(
      shouldUseThreadReplyAck("correction-ack", "<nowhere@meetmeatthefair.com>", null, repliedTo)
    ).toBe(false);
  });

  it("the workflow's swap passes what the parent was (wiring, not just the helper)", () => {
    const wf = readFileSync(join(__dirname, "../src/workflows/inbound-email.ts"), "utf8");
    expect(wf).toMatch(/classifyRepliedToSend\s*\(\s*db,/);
    expect(wf).toMatch(
      /shouldUseThreadReplyAck\(\s*replyKind,[\s\S]{0,120}?repliedTo \?\? "unknown"/
    );
  });
});

describe("a sibling is named in the ack only above the tunable threshold", () => {
  function family(claimConfidence: number) {
    const row = (id: string, intent: string, confidence: number | null, parent: string | null) =>
      db
        .insert(inboundEmails)
        .values({
          id,
          receivedAt: new Date(),
          createdAt: new Date(),
          fromAddress: "org@example.org",
          toAddress: "notify@meetmeatthefair.com",
          intent,
          classifiedConfidence: confidence,
          parentEmailId: parent,
        } as never)
        .run();
    row("p", "multi", 0.9, null);
    row("c", "correction", 0.95, "p");
    row("k", "claim_request", claimConfidence, "p");
  }

  it("default threshold: a 0.90 claim is NOT named (the specimen)", async () => {
    family(0.9);
    const min = await readFanoutAckMentionMinConfidence(db as never);
    expect(min).toBe(DEFAULT_FANOUT_ACK_MENTION_MIN_CONFIDENCE);
    const role = await resolveFanoutReplyRole(db as never, "c", min);
    expect(role?.isLeader).toBe(true);
    expect(role?.otherIntents).toEqual([]);
  });

  it("a 0.97 claim IS named (landmark — the filter is not simply 'never')", async () => {
    family(0.97);
    const role = await resolveFanoutReplyRole(
      db as never,
      "c",
      await readFanoutAckMentionMinConfidence(db as never)
    );
    expect(role?.otherIntents).toEqual(["claim_request"]);
  });

  it("the threshold is read from tunable_thresholds, not a constant", async () => {
    db.insert(tunableThresholds)
      .values({
        key: "fanout_ack_mention_min_confidence",
        value: 0.5,
        unit: "confidence",
        updatedAt: new Date(),
      } as never)
      .run();
    family(0.9);
    const min = await readFanoutAckMentionMinConfidence(db as never);
    expect(min).toBe(0.5);
    expect((await resolveFanoutReplyRole(db as never, "c", min))?.otherIntents).toEqual([
      "claim_request",
    ]);
  });
});
