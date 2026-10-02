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

  it("marks a rule promotable at ≥95% over ≥ threshold HUMAN-decided sample", () => {
    // 20 human approvals, 0 rejections → 100% over 20.
    const rows = Array.from({ length: RULE_PROMOTE_MIN_SAMPLE }, () => ({
      proposedField: "hero",
      extractionMethod: "jsonld",
      decision: "approved",
    }));
    const [entry] = computeRuleAgreement(rows);
    expect(entry.humanAgreementPct).toBeGreaterThanOrEqual(RULE_PROMOTE_MIN_PCT);
    expect(entry.humanSampleSize).toBe(RULE_PROMOTE_MIN_SAMPLE);
    expect(entry.promotable).toBe(true);
  });

  it("OPE-963 — auto_merged cannot self-certify: 20 auto-applies alone are NOT promotable", () => {
    // This test previously asserted the opposite (20 auto_merged → promotable),
    // which pinned the defect: a rule that auto-applies was approving itself.
    const rows = Array.from({ length: RULE_PROMOTE_MIN_SAMPLE }, () => ({
      proposedField: "hero",
      extractionMethod: "jsonld",
      decision: "auto_merged",
    }));
    const [entry] = computeRuleAgreement(rows);
    expect(entry.agreementPct).toBe(100); // the old figure still reads perfect…
    expect(entry.humanSampleSize).toBe(0); // …over zero human decisions
    expect(entry.promotable).toBe(false);
  });

  it("OPE-963 — the social-link shape: high blended agreement, human figure tells the truth", () => {
    // 170 auto-applies + 17 approved + 9 rejected ≈ the prod 95.4% @ n=196.
    const mk = (decision: string, n: number) =>
      Array.from({ length: n }, () => ({
        proposedField: "social_links",
        extractionMethod: "social-link",
        decision,
      }));
    const [e] = computeRuleAgreement([
      ...mk("auto_merged", 170),
      ...mk("approved", 17),
      ...mk("rejected", 9),
    ]);
    expect(e.agreementPct).toBe(95.4);
    expect(e.humanAgreementPct).toBe(65.4);
    expect(e.autoMerged).toBe(170);
    expect(e.promotable).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// OPE-249 (2026-10-02 rework) — the gate measures the population it acts on.
//
// The review scored social-link at 38.5% (10/26). Read from prod: 4 of the 16
// "rejects" were reviewed_by='system:promoter-merge' (a merged-away promoter's
// open candidates, closed as housekeeping), and every post-09-13 decision was a
// FLAGGED row — which auto-merge never applies (promoter-dispatch.ts skips any
// candidate with flags). Neither is evidence about whether the rule's CLEAN
// output can be auto-applied.
// ─────────────────────────────────────────────────────────────────────────────
describe("OPE-249 — system closes and flagged rows do not move the promotion gate", () => {
  const r = (decision: string, over: Partial<{ reviewedBy: string; flags: string }> = {}) => ({
    decision,
    proposedField: "social_links",
    extractionMethod: "social-link",
    ...over,
  });

  it("a system:promoter-merge reject is not a human disagreement — it is counted separately", () => {
    const [e] = computeRuleAgreement([
      r("approved", { reviewedBy: "admin-user-001", flags: "[]" }),
      r("rejected", { reviewedBy: "system:promoter-merge", flags: "[]" }),
    ]);
    expect(e.humanRejected).toBe(0);
    expect(e.humanSampleSize).toBe(1);
    expect(e.systemClosed).toBe(1);
  });

  it("a flagged decision counts in the human figure but NOT in the clean figure the gate uses", () => {
    const [e] = computeRuleAgreement([
      r("approved", { reviewedBy: "admin-user-001", flags: "[]" }),
      r("rejected", { reviewedBy: "admin-user-001", flags: '["social_no_name_affinity"]' }),
    ]);
    expect(e.humanSampleSize).toBe(2);
    expect(e.cleanHumanSampleSize).toBe(1);
    expect(e.cleanHumanAgreementPct).toBe(100);
  });

  it("promotion is gated on CLEAN human decisions: 20 clean approvals promote despite flagged rejects", () => {
    const rows = [
      ...Array.from({ length: 20 }, () => r("approved", { reviewedBy: "u", flags: "[]" })),
      ...Array.from({ length: 5 }, () =>
        r("rejected", { reviewedBy: "u", flags: '["social_no_name_affinity"]' })
      ),
    ];
    const [e] = computeRuleAgreement(rows);
    expect(e.humanAgreementPct).toBe(80); // the old gate would read 80% — not promotable
    expect(e.cleanHumanAgreementPct).toBe(100);
    expect(e.promotable).toBe(true);
  });

  it("…and a clean human reject still blocks it (the gate is not loosened for clean output)", () => {
    const rows = [
      ...Array.from({ length: 19 }, () => r("approved", { reviewedBy: "u", flags: "[]" })),
      r("rejected", { reviewedBy: "u", flags: "[]" }),
    ];
    const [e] = computeRuleAgreement(rows);
    expect(e.cleanHumanAgreementPct).toBe(95);
    expect(e.promotable).toBe(true);
    const [f] = computeRuleAgreement([...rows, r("rejected", { reviewedBy: "u", flags: "[]" })]);
    expect(f.promotable).toBe(false);
  });

  it("the prod social-link mix (2026-10-02) is NOT promotable under the corrected gate either", () => {
    // 26 clean approvals + 4 flagged approvals; 11 clean human rejects + 6
    // flagged human rejects; 4 system closes. Measured by direct D1 query.
    const rows = [
      ...Array.from({ length: 26 }, () => r("approved", { reviewedBy: "u", flags: "[]" })),
      ...Array.from({ length: 4 }, () => r("approved", { reviewedBy: "u", flags: '["x"]' })),
      ...Array.from({ length: 11 }, () => r("rejected", { reviewedBy: "u", flags: "[]" })),
      ...Array.from({ length: 6 }, () => r("rejected", { reviewedBy: "u", flags: '["x"]' })),
      ...Array.from({ length: 4 }, () =>
        r("rejected", { reviewedBy: "system:promoter-merge", flags: "[]" })
      ),
    ];
    const [e] = computeRuleAgreement(rows);
    expect(e.systemClosed).toBe(4);
    expect(e.cleanHumanSampleSize).toBe(37);
    expect(e.cleanHumanAgreementPct).toBe(70.3);
    expect(e.promotable).toBe(false);
  });

  it("rows with no reviewedBy/flags (older callers) behave exactly as before", () => {
    const [e] = computeRuleAgreement([r("approved"), r("rejected")]);
    expect(e.humanSampleSize).toBe(2);
    expect(e.cleanHumanSampleSize).toBe(2);
    expect(e.systemClosed).toBe(0);
  });
});
