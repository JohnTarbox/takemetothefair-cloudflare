import { describe, it, expect } from "vitest";
import {
  buildOutreachFunnel,
  medianTimeToConfirmMs,
  buildOutreachCoverage,
} from "./promoter-outreach-metrics";

describe("buildOutreachFunnel — cumulative, not point-in-time (OPE-384 stage 6)", () => {
  it("counts a CONFIRMED attempt as having been sent", () => {
    // THE trap. `status` holds where an attempt is NOW. A confirmed attempt is
    // no longer 'sent' — but it was. Counting status='sent' as "how many did
    // we send" under-reports by exactly the successes, so the funnel's
    // conversion rate would FALL as the rail improved.
    const f = buildOutreachFunnel([{ status: "confirmed", count: 5 }]);
    expect(f.sent).toBe(5);
    expect(f.confirmed).toBe(5);
    expect(f.confirmRate).toBe(1);
  });

  it("counts a replied attempt as sent, and a confirmed one as replied", () => {
    const f = buildOutreachFunnel([
      { status: "sent", count: 10 },
      { status: "replied", count: 3 },
      { status: "confirmed", count: 2 },
    ]);
    expect(f.sent).toBe(15);
    expect(f.replied).toBe(5);
    expect(f.confirmed).toBe(2);
  });

  it("keeps replied and confirmed SEPARATE", () => {
    // An organizer who writes "let me check with the committee" has replied
    // and confirmed nothing. Collapsing them would score that as a closed loop
    // and make time-to-confirm measure the wrong thing.
    const f = buildOutreachFunnel([{ status: "replied", count: 4 }]);
    expect(f.replied).toBe(4);
    expect(f.confirmed).toBe(0);
    expect(f.confirmRate).toBe(0);
  });

  it("excludes queued and refused from 'sent' — nothing left the building", () => {
    const f = buildOutreachFunnel([
      { status: "queued", count: 7 },
      { status: "refused", count: 2 },
    ]);
    expect(f.sent).toBe(0);
    expect(f.queued).toBe(7);
    expect(f.refused).toBe(2);
    expect(f.replyRate).toBeNull();
  });

  it("counts no_response and bounced as sent — both required a send", () => {
    const f = buildOutreachFunnel([
      { status: "no_response", count: 6 },
      { status: "bounced", count: 2 },
    ]);
    expect(f.sent).toBe(8);
    expect(f.bounceRate).toBeCloseTo(0.25, 6);
    expect(f.replyRate).toBe(0);
  });

  it("returns NULL rates on an empty denominator, never 0", () => {
    // A rail that has sent nothing has no reply rate. 0% would read as "we
    // asked and nobody answered" — the opposite of the truth, and the more
    // alarming of the two.
    const f = buildOutreachFunnel([]);
    expect(f.replyRate).toBeNull();
    expect(f.confirmRate).toBeNull();
    expect(f.bounceRate).toBeNull();
  });

  it("ignores a status it does not know rather than mis-bucketing it", () => {
    const f = buildOutreachFunnel([
      { status: "sent", count: 4 },
      { status: "some_future_status", count: 99 },
    ]);
    expect(f.sent).toBe(4);
  });
});

describe("medianTimeToConfirmMs", () => {
  it("is a median, not a mean", () => {
    // One organizer replying four months later would drag a mean past every
    // useful reading.
    const day = 86_400_000;
    expect(medianTimeToConfirmMs([1 * day, 2 * day, 3 * day, 120 * day])).toBe(2.5 * day);
  });

  it("handles odd and even counts", () => {
    expect(medianTimeToConfirmMs([10, 20, 30])).toBe(20);
    expect(medianTimeToConfirmMs([10, 20])).toBe(15);
  });

  it("returns null when nothing has confirmed yet", () => {
    expect(medianTimeToConfirmMs([])).toBeNull();
  });

  it("discards negative and non-finite durations", () => {
    // A negative duration means sent_at is after outcome_at — corrupt, and
    // averaging it in would silently shorten the headline.
    expect(medianTimeToConfirmMs([-5, NaN, 100, 200])).toBe(150);
  });
});

describe("buildOutreachCoverage", () => {
  it("computes the headline and the blocked split", () => {
    const c = buildOutreachCoverage({
      totalUpcoming: 1000,
      needingConfirmation: 200,
      contactable: 66,
      uncitedConfirmedDates: 155,
    });
    expect(c.fullyConfirmed).toBe(800);
    expect(c.coverageRate).toBeCloseTo(0.8, 6);
    expect(c.blockedOnEnrichment).toBe(134);
    expect(c.uncitedConfirmedDates).toBe(155);
  });

  it("never reports a negative count when inputs disagree", () => {
    // The two numbers come from different queries and can race; a negative
    // "fully confirmed" would render as nonsense rather than as a small skew.
    const c = buildOutreachCoverage({
      totalUpcoming: 10,
      needingConfirmation: 15,
      contactable: 20,
      uncitedConfirmedDates: 0,
    });
    expect(c.fullyConfirmed).toBe(0);
    expect(c.blockedOnEnrichment).toBe(0);
  });

  it("returns a null coverage rate with no upcoming events", () => {
    const c = buildOutreachCoverage({
      totalUpcoming: 0,
      needingConfirmation: 0,
      contactable: 0,
      uncitedConfirmedDates: 0,
    });
    expect(c.coverageRate).toBeNull();
  });
});
