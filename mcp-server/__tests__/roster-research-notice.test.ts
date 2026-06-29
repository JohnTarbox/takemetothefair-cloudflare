/**
 * OPE-15 — unit tests for the vendor-roster research-queue notice.
 *
 * Focused on the pure decision function `decideRosterNotice` — the gate that
 * encodes the issue's two debounce rules: ≤1/day AND only when the
 * producer-class NEEDS_RESEARCH count CHANGED since the last notice. The DB
 * read/email/upsert plumbing in runRosterResearchNotice is failsoft and mirrors
 * the standing-failure canary, which is covered separately.
 */
import { describe, expect, it } from "vitest";
import { __test } from "../src/roster-research-notice.js";

const { decideRosterNotice, utcDayKey, escapeHtml } = __test;

const TODAY = "2026-06-29";
const YESTERDAY = "2026-06-28";

describe("decideRosterNotice", () => {
  describe("empty queue is the happy path", () => {
    it("never notifies when count is 0, even on first run", () => {
      expect(decideRosterNotice(0, null, null, TODAY)).toBe(false);
    });
    it("never notifies on a negative/garbage count", () => {
      expect(decideRosterNotice(-3, null, null, TODAY)).toBe(false);
    });
    it("does not notify even if the backlog drained to 0 since last notice", () => {
      expect(decideRosterNotice(0, YESTERDAY, 12, TODAY)).toBe(false);
    });
  });

  describe("first run (no debounce state)", () => {
    it("notifies once for any non-empty producer-class queue", () => {
      expect(decideRosterNotice(7, null, null, TODAY)).toBe(true);
    });
  });

  describe("≤1/day gate", () => {
    it("skips when already notified today, even if the count changed", () => {
      expect(decideRosterNotice(20, TODAY, 12, TODAY)).toBe(false);
    });
    it("the today-gate wins over a changed count on the same day", () => {
      // count differs from last (20 != 12) but it's still today → mute.
      expect(decideRosterNotice(20, TODAY, 12, TODAY)).toBe(false);
    });
  });

  describe("changed-since-last gate", () => {
    it("skips an unchanged backlog on a later day (don't nag)", () => {
      expect(decideRosterNotice(12, YESTERDAY, 12, TODAY)).toBe(false);
    });
    it("notifies when the backlog grew since the last notice", () => {
      expect(decideRosterNotice(15, YESTERDAY, 12, TODAY)).toBe(true);
    });
    it("notifies when the backlog shrank but is still non-empty", () => {
      expect(decideRosterNotice(8, YESTERDAY, 12, TODAY)).toBe(true);
    });
  });

  describe("interaction — both gates must pass to fire", () => {
    it("fires only when it's a new day AND the count changed", () => {
      expect(decideRosterNotice(15, YESTERDAY, 12, TODAY)).toBe(true); // new day + changed
      expect(decideRosterNotice(12, YESTERDAY, 12, TODAY)).toBe(false); // new day, unchanged
      expect(decideRosterNotice(15, TODAY, 12, TODAY)).toBe(false); // changed, same day
    });
  });
});

describe("utcDayKey", () => {
  it("formats a Date as YYYY-MM-DD in UTC", () => {
    expect(utcDayKey(new Date("2026-06-29T13:37:00Z"))).toBe("2026-06-29");
  });
  it("is stable just before midnight UTC (no local-tz drift)", () => {
    expect(utcDayKey(new Date("2026-06-29T23:59:59Z"))).toBe("2026-06-29");
  });
});

describe("escapeHtml", () => {
  it("escapes the characters that would break the email body", () => {
    expect(escapeHtml('Earth Expo & Convention <Center> "NH"')).toBe(
      "Earth Expo &amp; Convention &lt;Center&gt; &quot;NH&quot;"
    );
  });
});
