import { describe, it, expect } from "vitest";
import {
  canOutreachTransition,
  assertOutreachTransition,
  evaluateOutreachTimeout,
  buildFollowUpDraft,
  NO_RESPONSE_TIMEOUT_DAYS,
  PROMOTER_OUTREACH_TRANSITIONS,
} from "./promoter-outreach-state";

const DAY = 86_400_000;
const SENT = new Date("2026-06-01T12:00:00Z");
const at = (days: number) => new Date(SENT.getTime() + days * DAY);

describe("evaluateOutreachTimeout — the clock is sent_at, never created_at", () => {
  it("NEVER expires a queued attempt, however old", () => {
    // THE trap this stage exists for. A queued attempt is one the enablement
    // gate refused: it has a created_at and no sent_at because nobody was
    // asked. Ageing it into no_response would record that an organizer
    // ignored an email that never left the building — and would do so most
    // often exactly while the rail was switched off.
    const v = evaluateOutreachTimeout({
      status: "queued",
      sentAt: null,
      followUpOf: null,
      now: at(3650),
    });
    expect(v.action).toBe("wait");
    expect(v).toMatchObject({ reason: expect.stringContaining("nobody has been asked") });
  });

  it("does not expire a `sent` row whose sent_at is null — that is a data fault", () => {
    // Distinct from the queued case: here the status claims we sent. A missing
    // timestamp is a broken write, and treating it as aged-out would let that
    // bug silently manufacture no_response rows.
    const v = evaluateOutreachTimeout({
      status: "sent",
      sentAt: null,
      followUpOf: null,
      now: at(3650),
    });
    expect(v).toEqual({ action: "wait", reason: expect.stringContaining("data fault") });
  });

  it.each(["replied", "confirmed", "no_response", "bounced", "refused"] as const)(
    "does not expire a %s attempt — it is not awaiting a reply",
    (status) => {
      const v = evaluateOutreachTimeout({
        status,
        // A sent_at far in the past: only the STATUS may keep this from
        // expiring, so a check that looked at the clock alone would fail here.
        sentAt: SENT,
        followUpOf: null,
        now: at(999),
      });
      expect(v.action).toBe("wait");
    }
  );

  it("waits one instant BEFORE the timeout and expires exactly ON it", () => {
    const justBefore = evaluateOutreachTimeout({
      status: "sent",
      sentAt: SENT,
      followUpOf: null,
      now: new Date(SENT.getTime() + NO_RESPONSE_TIMEOUT_DAYS * DAY - 1),
    });
    expect(justBefore.action).toBe("wait");

    const exactly = evaluateOutreachTimeout({
      status: "sent",
      sentAt: SENT,
      followUpOf: null,
      now: new Date(SENT.getTime() + NO_RESPONSE_TIMEOUT_DAYS * DAY),
    });
    expect(exactly.action).toBe("expire");
  });

  it("reports days remaining while still inside the window", () => {
    const v = evaluateOutreachTimeout({
      status: "sent",
      sentAt: SENT,
      followUpOf: null,
      now: at(4),
    });
    expect(v).toMatchObject({ action: "wait", daysRemaining: NO_RESPONSE_TIMEOUT_DAYS - 4 });
  });

  it("honours an explicit timeoutDays override", () => {
    const v = evaluateOutreachTimeout({
      status: "sent",
      sentAt: SENT,
      followUpOf: null,
      now: at(3),
      timeoutDays: 2,
    });
    expect(v).toMatchObject({ action: "expire", followUp: true });
  });
});

describe("evaluateOutreachTimeout — the follow-up cap is structural", () => {
  it("earns a follow-up for a first ask", () => {
    const v = evaluateOutreachTimeout({
      status: "sent",
      sentAt: SENT,
      followUpOf: null,
      now: at(30),
    });
    expect(v).toMatchObject({ action: "expire", followUp: true });
  });

  it("does NOT earn a second follow-up for an attempt that IS one", () => {
    // Same status, same silence, same clock — the ONLY difference from the
    // case above is followUpOf. The cap is the presence of that column, so a
    // cap implemented as a counter that nobody increments would pass the test
    // above and fail this one.
    const v = evaluateOutreachTimeout({
      status: "sent",
      sentAt: SENT,
      followUpOf: "attempt-1",
      now: at(30),
    });
    expect(v).toMatchObject({ action: "expire", followUp: false });
  });
});

describe("outreach transitions", () => {
  it("allows the forward path queued -> sent -> replied -> confirmed", () => {
    expect(canOutreachTransition("queued", "sent")).toBe(true);
    expect(canOutreachTransition("sent", "replied")).toBe(true);
    expect(canOutreachTransition("replied", "confirmed")).toBe(true);
  });

  it("refuses to walk an attempt backwards", () => {
    // Backwards is the dangerous direction: `queued` and `sent` are the two
    // statuses the partial unique index treats as open, so reopening a closed
    // attempt would re-suppress the event.
    expect(() => assertOutreachTransition("replied", "sent")).toThrow(/replied -> sent/);
    expect(() => assertOutreachTransition("confirmed", "sent")).toThrow();
    expect(() => assertOutreachTransition("no_response", "queued")).toThrow();
  });

  it("treats bounced as terminal — a live address is a NEW attempt", () => {
    // Rewriting this row would claim we wrote to an address we never used.
    expect(canOutreachTransition("bounced", "queued")).toBe(false);
    expect(() => assertOutreachTransition("bounced", "sent")).toThrow(/terminal/);
  });

  it("does not let a send skip straight to confirmed", () => {
    expect(canOutreachTransition("sent", "confirmed")).toBe(false);
  });

  it("names the legal moves in the error, so the operator is not guessing", () => {
    expect(() => assertOutreachTransition("queued", "confirmed")).toThrow(/only: sent, refused/);
  });

  it("every status in the map has an entry, and no entry names an unknown status", () => {
    const keys = Object.keys(PROMOTER_OUTREACH_TRANSITIONS);
    for (const [from, tos] of Object.entries(PROMOTER_OUTREACH_TRANSITIONS)) {
      for (const to of tos) {
        expect(keys, `${from} -> ${to}`).toContain(to);
      }
    }
  });
});

describe("buildFollowUpDraft", () => {
  it("threads on the original subject and names the date we first wrote", () => {
    const d = buildFollowUpDraft({
      eventName: "Dartmouth Grange Fair",
      originalSubject: "Confirming this year's dates for Dartmouth Grange Fair",
      originalSentAt: SENT,
    });
    expect(d.subject).toBe("Re: Confirming this year's dates for Dartmouth Grange Fair");
    expect(d.body).toContain("2026-06-01");
    expect(d.body).toContain("Dartmouth Grange Fair");
  });

  it("offers a way to make us stop", () => {
    const d = buildFollowUpDraft({
      eventName: "X",
      originalSubject: "S",
      originalSentAt: SENT,
    });
    expect(d.body).toMatch(/rather we not write again/);
  });

  it("keeps the subject inside the column's 200 characters", () => {
    const d = buildFollowUpDraft({
      eventName: "X",
      originalSubject: "S".repeat(400),
      originalSentAt: SENT,
    });
    expect(d.subject.length).toBeLessThanOrEqual(200);
  });
});
