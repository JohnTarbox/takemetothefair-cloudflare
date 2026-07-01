import { describe, it, expect } from "vitest";
import {
  computeAutoApplyShare,
  computeRuleAgreement,
  summarizeBlockedReasons,
  bucketByWeek,
  RULE_PROMOTE_MIN_PCT,
  RULE_PROMOTE_MIN_SAMPLE,
} from "../promoter-enrichment-dashboard";

// OPE-38 — pure aggregation math for the promoter-enrichment flywheel dashboard.

describe("computeAutoApplyShare", () => {
  it("share = auto_merged / (auto_merged + approved); rejected + pending excluded", () => {
    const rows = [
      { decision: "auto_merged" },
      { decision: "auto_merged" },
      { decision: "auto_merged" },
      { decision: "approved" },
      { decision: "rejected" }, // excluded from denominator
      { decision: "pending" }, // excluded from denominator
    ];
    const r = computeAutoApplyShare(rows);
    expect(r.autoMerged).toBe(3);
    expect(r.approved).toBe(1);
    expect(r.decided).toBe(4);
    expect(r.autoApplyPct).toBe(75); // 3/4
  });

  it("empty data → 0% (no divide-by-zero)", () => {
    expect(computeAutoApplyShare([])).toEqual({
      autoMerged: 0,
      approved: 0,
      decided: 0,
      autoApplyPct: 0,
    });
  });

  it("all rejected/pending → decided 0, 0%", () => {
    const r = computeAutoApplyShare([{ decision: "rejected" }, { decision: "pending" }]);
    expect(r.decided).toBe(0);
    expect(r.autoApplyPct).toBe(0);
  });

  it("rounds to one decimal", () => {
    // 2 auto_merged of 3 decided = 66.666… → 66.7
    const r = computeAutoApplyShare([
      { decision: "auto_merged" },
      { decision: "auto_merged" },
      { decision: "approved" },
    ]);
    expect(r.autoApplyPct).toBe(66.7);
  });
});

describe("computeRuleAgreement", () => {
  it("groups by (proposedField, extractionMethod); agreements = approved + auto_merged, disagreements = rejected", () => {
    const rows = [
      { proposedField: "logo", extractionMethod: "og-image", decision: "auto_merged" },
      { proposedField: "logo", extractionMethod: "og-image", decision: "approved" },
      { proposedField: "logo", extractionMethod: "og-image", decision: "rejected" },
      { proposedField: "contact_email", extractionMethod: "mailto", decision: "approved" },
      { proposedField: "contact_email", extractionMethod: "mailto", decision: "pending" }, // skipped
    ];
    const out = computeRuleAgreement(rows);
    const logo = out.find((e) => e.proposedField === "logo" && e.extractionMethod === "og-image")!;
    expect(logo.agreements).toBe(2);
    expect(logo.disagreements).toBe(1);
    expect(logo.sampleSize).toBe(3);
    expect(logo.agreementPct).toBe(66.7);
    const mail = out.find((e) => e.proposedField === "contact_email")!;
    expect(mail.sampleSize).toBe(1); // pending excluded
    expect(mail.agreementPct).toBe(100);
  });

  it("marks a rule promotable at ≥95% over ≥ threshold sample", () => {
    // 20 agreements, 0 disagreements → 100% over 20.
    const rows = Array.from({ length: RULE_PROMOTE_MIN_SAMPLE }, () => ({
      proposedField: "hero",
      extractionMethod: "jsonld",
      decision: "auto_merged",
    }));
    const [entry] = computeRuleAgreement(rows);
    expect(entry.agreementPct).toBeGreaterThanOrEqual(RULE_PROMOTE_MIN_PCT);
    expect(entry.sampleSize).toBe(RULE_PROMOTE_MIN_SAMPLE);
    expect(entry.promotable).toBe(true);
  });

  it("not promotable when sample too small even at 100%", () => {
    const rows = [
      { proposedField: "hero", extractionMethod: "jsonld", decision: "approved" },
      { proposedField: "hero", extractionMethod: "jsonld", decision: "auto_merged" },
    ];
    const [entry] = computeRuleAgreement(rows);
    expect(entry.agreementPct).toBe(100);
    expect(entry.sampleSize).toBe(2);
    expect(entry.promotable).toBe(false);
  });

  it("not promotable below 95% even with large sample", () => {
    const rows = [
      ...Array.from({ length: 90 }, () => ({
        proposedField: "description",
        extractionMethod: "regex",
        decision: "approved",
      })),
      ...Array.from({ length: 10 }, () => ({
        proposedField: "description",
        extractionMethod: "regex",
        decision: "rejected",
      })),
    ];
    const [entry] = computeRuleAgreement(rows);
    expect(entry.agreementPct).toBe(90);
    expect(entry.sampleSize).toBe(100);
    expect(entry.promotable).toBe(false);
  });

  it("sorts by sample size desc then agreement pct desc", () => {
    const rows = [
      { proposedField: "a", extractionMethod: "m", decision: "approved" },
      { proposedField: "b", extractionMethod: "m", decision: "approved" },
      { proposedField: "b", extractionMethod: "m", decision: "approved" },
    ];
    const out = computeRuleAgreement(rows);
    expect(out[0].proposedField).toBe("b"); // sampleSize 2 first
    expect(out[1].proposedField).toBe("a");
  });

  it("empty data → empty array", () => {
    expect(computeRuleAgreement([])).toEqual([]);
  });
});

describe("summarizeBlockedReasons", () => {
  it("groups counts by reason, ignores NULL, computes rate vs total promoters", () => {
    const groupRows = [
      { reason: "js_gated", n: 3 },
      { reason: "parked", n: 1 },
      { reason: null, n: 40 }, // non-blocked promoters — ignored
    ];
    const r = summarizeBlockedReasons(groupRows, 50);
    expect(r.blockedTotal).toBe(4);
    expect(r.byReason).toEqual({ js_gated: 3, parked: 1 });
    expect(r.blockedRatePct).toBe(8); // 4/50
  });

  it("empty data → zeros, no divide-by-zero", () => {
    expect(summarizeBlockedReasons([], 0)).toEqual({
      blockedTotal: 0,
      blockedRatePct: 0,
      byReason: {},
    });
  });
});

describe("bucketByWeek", () => {
  it("buckets timestamps into Monday-anchored ISO weeks, ascending", () => {
    // 2026-06-24 is a Wednesday → Monday 2026-06-22.
    // 2026-06-29 is a Monday → 2026-06-29.
    const rows = [
      { createdAt: new Date("2026-06-24T12:00:00Z") },
      { createdAt: new Date("2026-06-25T09:00:00Z") },
      { createdAt: new Date("2026-06-29T00:00:00Z") },
      { createdAt: null }, // dropped
    ];
    const out = bucketByWeek(rows);
    expect(out).toEqual([
      { weekStart: "2026-06-22", count: 2 },
      { weekStart: "2026-06-29", count: 1 },
    ]);
  });

  it("accepts epoch-number timestamps and drops invalid ones", () => {
    const out = bucketByWeek([
      { createdAt: Date.UTC(2026, 5, 24) }, // Wed → Mon 2026-06-22
      { createdAt: Number.NaN },
    ]);
    expect(out).toEqual([{ weekStart: "2026-06-22", count: 1 }]);
  });

  it("empty data → empty array", () => {
    expect(bucketByWeek([])).toEqual([]);
  });
});
