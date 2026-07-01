/**
 * OPE-37 — unit tests for the promoter-enrichment queue notice.
 *
 * Focused on the pure decision function `decidePromoterEnrichmentNotice` — the
 * gate that encodes the two debounce rules: ≤1/day AND only when the
 * NEEDS_ENRICHMENT count CHANGED since the last notice. The DB read / email /
 * upsert plumbing in runPromoterEnrichmentNotice is failsoft and mirrors the
 * roster / inbound notices, which are covered separately. Direct analog of
 * roster-research-notice.test.ts.
 */
import { describe, expect, it } from "vitest";
import { __test } from "../src/promoter-enrichment-notice.js";

const { decidePromoterEnrichmentNotice, utcDayKey, escapeHtml, formatCoverageLine } = __test;

const TODAY = "2026-07-01";
const YESTERDAY = "2026-06-30";

describe("decidePromoterEnrichmentNotice", () => {
  describe("empty queue is the happy path", () => {
    it("never notifies when count is 0, even on first run", () => {
      expect(decidePromoterEnrichmentNotice(0, null, null, TODAY)).toBe(false);
    });
    it("never notifies on a negative/garbage count", () => {
      expect(decidePromoterEnrichmentNotice(-3, null, null, TODAY)).toBe(false);
    });
    it("does not notify even if the backlog drained to 0 since last notice", () => {
      expect(decidePromoterEnrichmentNotice(0, YESTERDAY, 12, TODAY)).toBe(false);
    });
  });

  describe("first run (no debounce state) → non-empty notifies", () => {
    it("notifies once for any non-empty enrichment queue", () => {
      expect(decidePromoterEnrichmentNotice(7, null, null, TODAY)).toBe(true);
    });
  });

  describe("≤1/day gate", () => {
    it("skips when already notified today, even if the count changed", () => {
      expect(decidePromoterEnrichmentNotice(20, TODAY, 12, TODAY)).toBe(false);
    });
    it("the today-gate wins over a changed count on the same day", () => {
      expect(decidePromoterEnrichmentNotice(20, TODAY, 12, TODAY)).toBe(false);
    });
  });

  describe("changed-since-last gate", () => {
    it("skips an unchanged backlog on a later day (don't nag)", () => {
      expect(decidePromoterEnrichmentNotice(12, YESTERDAY, 12, TODAY)).toBe(false);
    });
    it("re-notifies when the backlog grew since the last notice", () => {
      expect(decidePromoterEnrichmentNotice(15, YESTERDAY, 12, TODAY)).toBe(true);
    });
    it("re-notifies when the backlog shrank but is still non-empty", () => {
      expect(decidePromoterEnrichmentNotice(8, YESTERDAY, 12, TODAY)).toBe(true);
    });
  });

  describe("interaction — both gates must pass to fire", () => {
    it("fires only when it's a new day AND the count changed", () => {
      expect(decidePromoterEnrichmentNotice(15, YESTERDAY, 12, TODAY)).toBe(true); // new day + changed
      expect(decidePromoterEnrichmentNotice(12, YESTERDAY, 12, TODAY)).toBe(false); // new day, unchanged
      expect(decidePromoterEnrichmentNotice(15, TODAY, 12, TODAY)).toBe(false); // changed, same day
    });
  });
});

describe("utcDayKey", () => {
  it("formats a Date as YYYY-MM-DD in UTC", () => {
    expect(utcDayKey(new Date("2026-07-01T13:37:00Z"))).toBe("2026-07-01");
  });
  it("is stable just before midnight UTC (no local-tz drift)", () => {
    expect(utcDayKey(new Date("2026-07-01T23:59:59Z"))).toBe("2026-07-01");
  });
});

describe("escapeHtml", () => {
  it("escapes the characters that would break the email body", () => {
    expect(escapeHtml('Earth Expo & Convention <Center> "NH"')).toBe(
      "Earth Expo &amp; Convention &lt;Center&gt; &quot;NH&quot;"
    );
  });
});

describe("formatCoverageLine", () => {
  it("renders a compact per-field coverage summary", () => {
    expect(
      formatCoverageLine(100, { hero: 12, logo: 30, description: 55, socials: 8, contact: 40 })
    ).toBe("hero 12/100, logo 30/100, description 55/100, socials 8/100, contact 40/100");
  });
});
