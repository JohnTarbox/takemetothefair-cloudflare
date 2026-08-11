/**
 * OPE-365 (R1) — replay proof.
 *
 * The ticket's central acceptance: run Katie's ACTUAL message through the new
 * decision and show it produces an obligation. "A design that would not have
 * caught her does not close this ticket."
 *
 * Every row below is real production data, read from D1 on 2026-08-11:
 *
 *   id                                    from                     intent  conf  flagged
 *   1b65e94a-7f66-4aca-9482-c22850bb4cbb  ktkellycrafts@gmail.com  support 0.90  0
 *   1ae45c3f-9c9d-464c-bfab-d94cc2826a11  wayne@plushcargo.com     support 0.82  1
 *   62dcd389-34c4-4d1b-8cde-13a39442e5ab  james@dowebnseo.com      support 0.82  1
 *   47d77f37-2e72-475f-b948-bcc48285ed14  holly@plushcargo.com     support 0.82  1
 *
 * Note what that table shows: the old signal caught all three pieces of SEO
 * cold-outreach and missed the one real customer. Not by accident — by
 * construction, because it keys off classifier UNCERTAINTY.
 */
import { describe, it, expect } from "vitest";
import {
  decideObligation,
  isSystemSender,
  extractEmailAddress,
  ACK_TERMINATING_INTENTS,
} from "@takemetothefair/utils";

/** The real production rows, verbatim. */
const KATIE = {
  id: "1b65e94a-7f66-4aca-9482-c22850bb4cbb",
  fromAddress: "ktkellycrafts@gmail.com",
  toAddress: "hello@meetmeatthefair.com",
  classifiedIntent: "support",
  classifiedConfidence: 0.9,
  flaggedForReview: 0,
};

const OUTREACH = [
  { fromAddress: "wayne@plushcargo.com", classifiedConfidence: 0.82, flaggedForReview: 1 },
  { fromAddress: "james@dowebnseo.com", classifiedConfidence: 0.82, flaggedForReview: 1 },
  { fromAddress: "holly@plushcargo.com", classifiedConfidence: 0.82, flaggedForReview: 1 },
];

describe("OPE-365 replay — Katie's actual message", () => {
  it("opens an obligation for her, where the old system opened nothing", () => {
    const decision = decideObligation({
      fromAddress: KATIE.fromAddress,
      toAddress: KATIE.toAddress,
      classifiedIntent: KATIE.classifiedIntent,
      classifiedConfidence: KATIE.classifiedConfidence,
      suppressed: false,
    });
    expect(decision.obligated).toBe(true);

    // And the reason it used to fail: the ONLY human-attention signal was
    // flagged_for_review, which was 0 for her.
    expect(KATIE.flaggedForReview).toBe(0);
  });

  it("would open it at ANY confidence — the inversion is gone", () => {
    // This is the property, not the specimen. The old behaviour made a clearer
    // bug report less likely to be seen; nothing here reads confidence at all.
    for (const confidence of [0.0, 0.32, 0.82, 0.9, 1.0, null]) {
      const d = decideObligation({
        fromAddress: KATIE.fromAddress,
        classifiedIntent: "support",
        classifiedConfidence: confidence,
        suppressed: false,
      });
      expect(d.obligated).toBe(true);
    }
  });
});

describe("OPE-365 replay — the low-confidence outreach specimens", () => {
  it("also opens obligations for them, and that is the honest answer", () => {
    // Deliberately NOT auto-suppressed. Nothing in the classified row separates
    // wayne@plushcargo.com from ktkellycrafts@gmail.com: same intent, same
    // reply_kind, null sub_intent, confidences 0.82 vs 0.90. Inventing a
    // heuristic here is exactly how the original bug was built — the system
    // guessed importance and guessed backwards.
    //
    // They are distinguishable AFTER a human triages them, in seconds, with the
    // distinction recorded as `not_an_obligation`. That keeps "we answered
    // everyone" and "we ignored everyone" countable apart, which no automatic
    // guess can promise.
    for (const row of OUTREACH) {
      const d = decideObligation({
        fromAddress: row.fromAddress,
        classifiedIntent: "support",
        classifiedConfidence: row.classifiedConfidence,
        suppressed: false,
      });
      expect(d.obligated).toBe(true);
    }
  });

  it("documents the inversion the old signal produced", () => {
    // The old flag caught 3/3 spam and 0/1 real customers.
    const flaggedSpam = OUTREACH.filter((r) => r.flaggedForReview === 1).length;
    expect(flaggedSpam).toBe(3);
    expect(KATIE.flaggedForReview).toBe(0);
  });
});

describe("OPE-365 exclusion rule", () => {
  it("excludes our own domain talking to itself", () => {
    // My own OPE-348 drill alerts landed back in inbound_emails as audit-noop
    // rows, because alert@ routes into our own worker. Those must never open an
    // obligation — we do not owe ourselves a reply.
    expect(isSystemSender("notify@meetmeatthefair.com")).toBe(true);
    expect(isSystemSender("alert@meetmeatthefair.com")).toBe(true);
    expect(isSystemSender("Meet Me at the Fair <notify@meetmeatthefair.com>")).toBe(true);
  });

  it("excludes Cloudflare's notification domain", () => {
    // One of only two email rows problem_reports ever ingested was a Cloudflare
    // Email Routing verification notice — a queue seeded with its own exhaust.
    expect(isSystemSender("noreply@notify.cloudflare.com")).toBe(true);
  });

  it("excludes machine local-parts by anchor, not substring", () => {
    expect(isSystemSender("no-reply@example.com")).toBe(true);
    expect(isSystemSender("donotreply@example.com")).toBe(true);
    expect(isSystemSender("mailer-daemon@example.com")).toBe(true);
    // A real person whose address merely CONTAINS the word must survive.
    expect(isSystemSender("jim.noreply.smith@example.com")).toBe(false);
    expect(isSystemSender("noreplyfabrics@gmail.com")).toBe(false);
  });

  it("treats an unparseable sender as a system sender", () => {
    expect(isSystemSender("")).toBe(true);
  });

  it("does not owe a reply to someone who unsubscribed", () => {
    const d = decideObligation({
      fromAddress: "someone@example.com",
      classifiedIntent: "support",
      suppressed: true,
    });
    expect(d).toEqual({ obligated: false, reason: "suppressed" });
  });

  it("ignores intents whose handler takes an action rather than acking", () => {
    // submit / correction / unsubscribe do something; they do not leave a
    // person waiting on a human.
    for (const intent of ["submit", "correction", "unsubscribe", "spam", "photo_intake"]) {
      expect(decideObligation({ fromAddress: "a@b.com", classifiedIntent: intent }).obligated).toBe(
        false
      );
    }
    for (const intent of ACK_TERMINATING_INTENTS) {
      expect(decideObligation({ fromAddress: "a@b.com", classifiedIntent: intent }).obligated).toBe(
        true
      );
    }
  });
});

describe("extractEmailAddress", () => {
  it("unwraps a display-name address", () => {
    expect(extractEmailAddress("Katie <ktkellycrafts@gmail.com>")).toBe("ktkellycrafts@gmail.com");
  });
  it("passes a bare address through", () => {
    expect(extractEmailAddress("ktkellycrafts@gmail.com")).toBe("ktkellycrafts@gmail.com");
  });
});
