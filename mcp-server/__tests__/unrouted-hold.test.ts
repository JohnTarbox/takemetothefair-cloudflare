/**
 * OPE-327 ruling 1 — the abuse guard on hold-and-ask.
 *
 * John's ruling is "hold-and-ask applies to unknown senders too, WITH an abuse
 * guard". Both halves matter and they pull against each other: too strict and a
 * first-time vendor gets silence, too loose and a stranger fills the queue.
 * These pin where that line sits.
 */
import { describe, expect, it } from "vitest";
import {
  decideUnroutedHold,
  holdLimitFor,
  holdExpiryCutoff,
  isHoldExpired,
  MAX_HOLDS_PER_UNKNOWN_SENDER,
  MAX_HOLDS_PER_TRUSTED_SENDER,
  HOLD_EXPIRY_DAYS,
} from "../src/inbound/unrouted-hold.js";

describe("decideUnroutedHold — the first email always gets an answer", () => {
  it("asks an unknown sender with no history", () => {
    // The whole point of the ruling: a stranger's first email is a question,
    // not silence and not a terminal failure reply.
    expect(decideUnroutedHold({ senderTrust: "unknown", openHoldCount: 0 })).toMatchObject({
      action: "ask",
    });
  });

  it("asks a trusted sender", () => {
    expect(decideUnroutedHold({ senderTrust: "trusted", openHoldCount: 0 }).action).toBe("ask");
  });

  it("keeps asking right up to the ceiling", () => {
    expect(
      decideUnroutedHold({
        senderTrust: "unknown",
        openHoldCount: MAX_HOLDS_PER_UNKNOWN_SENDER - 1,
      }).action
    ).toBe("ask");
  });
});

describe("decideUnroutedHold — the guard", () => {
  it("suppresses once an unknown sender is at the ceiling", () => {
    expect(
      decideUnroutedHold({ senderTrust: "unknown", openHoldCount: MAX_HOLDS_PER_UNKNOWN_SENDER })
        .action
    ).toBe("suppress");
  });

  it("gives trusted senders far more room than unknown ones", () => {
    // A trusted sender's holds are the ones most likely to become real events;
    // throttling them at the stranger ceiling would be the wrong trade.
    expect(holdLimitFor("trusted")).toBeGreaterThan(holdLimitFor("unknown"));
    expect(
      decideUnroutedHold({ senderTrust: "trusted", openHoldCount: MAX_HOLDS_PER_UNKNOWN_SENDER })
        .action
    ).toBe("ask");
  });

  it("treats 'known' like unknown, not like trusted", () => {
    // 'known' means we've seen the address, not that we vouch for it. Erring
    // toward the tighter ceiling costs a stranger one unanswered question;
    // erring the other way is an open queue.
    expect(holdLimitFor("known")).toBe(holdLimitFor("unknown"));
  });

  it("explains itself in the reason, including the limit that applied", () => {
    const d = decideUnroutedHold({ senderTrust: "unknown", openHoldCount: 5 });
    expect(d.reason).toContain("limit");
    expect(d.limit).toBe(MAX_HOLDS_PER_UNKNOWN_SENDER);
  });

  it("suppresses the QUESTION, and the reason says the email is still kept", () => {
    // A suppressed hold must never read as a dropped email. If this wording
    // drifts, the next reader will assume the guard discards mail.
    const d = decideUnroutedHold({ senderTrust: "unknown", openHoldCount: 99 });
    expect(d.action).toBe("suppress");
    expect(d.reason).toMatch(/still queued|still stored/i);
  });
});

describe("hold expiry", () => {
  const now = new Date("2026-08-10T00:00:00Z");

  it("expires an unanswered hold past the window", () => {
    // Without expiry the queue is bounded only by (senders x limit), which
    // grows forever as new senders arrive.
    const old = new Date(now.getTime() - (HOLD_EXPIRY_DAYS + 1) * 86_400_000);
    expect(isHoldExpired(old, now)).toBe(true);
  });

  it("does NOT expire one still inside the window", () => {
    const recent = new Date(now.getTime() - (HOLD_EXPIRY_DAYS - 1) * 86_400_000);
    expect(isHoldExpired(recent, now)).toBe(false);
  });

  it("puts the cutoff exactly HOLD_EXPIRY_DAYS back", () => {
    const cutoff = holdExpiryCutoff(now);
    expect(now.getTime() - cutoff.getTime()).toBe(HOLD_EXPIRY_DAYS * 86_400_000);
  });

  it("is long enough that expiring one cannot kill a live conversation", () => {
    // 14 days is past any plausible reply window. If someone shortens this to
    // days, a vendor who replies after a week loses their thread.
    expect(HOLD_EXPIRY_DAYS).toBeGreaterThanOrEqual(7);
  });

  it("honours an explicit window override, for callers that need a different one", () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);
    expect(isHoldExpired(threeDaysAgo, now, 2)).toBe(true);
    expect(isHoldExpired(threeDaysAgo, now, 30)).toBe(false);
  });
});

describe("the two limits are independent controls", () => {
  it("a per-sender ceiling alone would not bound the queue", () => {
    // Documented as an assertion so the relationship is not just prose: the
    // rate limit caps ONE sender, expiry is what caps the total.
    expect(MAX_HOLDS_PER_UNKNOWN_SENDER).toBeGreaterThan(0);
    expect(HOLD_EXPIRY_DAYS).toBeGreaterThan(0);
    expect(MAX_HOLDS_PER_TRUSTED_SENDER).toBeGreaterThan(MAX_HOLDS_PER_UNKNOWN_SENDER);
  });
});
