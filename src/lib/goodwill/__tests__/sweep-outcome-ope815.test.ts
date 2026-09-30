/**
 * OPE-815 — the sweep outcome that did not exist.
 *
 * `sweep/route.ts` had `if (drift > THRESHOLD) { … }` with **no else**. When
 * an organizer fixed their page the sweep took no branch at all: the finding
 * stayed `resolved_at IS NULL`, the radar lifted it again next run, and
 * `captureDiscrepancy` refreshed `last_seen_at` on the open discrepancy.
 *
 * Specimen: `jenksproductions.com` recorded `divergent_value = 2025-11-15`,
 * `last_seen_at = 2026-09-05 06:00`. The page reads "November 15, 2026",
 * matching us exactly. The row asserted it had been verified that morning.
 */
import { describe, expect, it } from "vitest";
import { classifySweepOutcome, mayRefreshRecency } from "../sweep-outcome";

const THRESHOLD = 1;
const d = (iso: string) => new Date(iso);

describe("the missing outcome", () => {
  it("a fetch that now AGREES clears the finding — the jenksproductions case", () => {
    // Stored 2026-11-15, page now says 2026-11-15. Drift 0.
    expect(classifySweepOutcome(d("2026-11-15"), 0, THRESHOLD)).toBe("drift-cleared");
  });

  it("a fetch that still disagrees records drift — nrtofeaston / worcestercraftcenter", () => {
    // nrtofeaston: page reads 2025-10-05, event is 2026-10-04 → ~364d.
    expect(classifySweepOutcome(d("2025-10-05"), 364, THRESHOLD)).toBe("drift-recorded");
    // worcestercraftcenter: page reads 2024-11-29, event 2026-11-27 → ~729d.
    expect(classifySweepOutcome(d("2024-11-29"), 729, THRESHOLD)).toBe("drift-recorded");
  });

  it("a fetch that failed is its OWN outcome, not agreement", () => {
    // ⚠️ The distinction that matters. If a 403 collapsed into "cleared", a
    // site that starts blocking us would silently close every real finding
    // against it. If it collapsed into "recorded", the row would claim fresh
    // evidence it does not have.
    expect(classifySweepOutcome(null, Number.NaN, THRESHOLD)).toBe("fetch-failed");
    expect(classifySweepOutcome(null, 0, THRESHOLD)).toBe("fetch-failed");
    expect(classifySweepOutcome(d("2026-01-01"), Number.NaN, THRESHOLD)).toBe("fetch-failed");
  });

  it("drift exactly AT the threshold clears; above it records", () => {
    expect(classifySweepOutcome(d("2026-01-02"), 1, THRESHOLD)).toBe("drift-cleared");
    expect(classifySweepOutcome(d("2026-01-03"), 2, THRESHOLD)).toBe("drift-recorded");
  });

  it("a NEGATIVE drift is still a disagreement", () => {
    // The source may be ahead of us as easily as behind. Comparing a signed
    // value against a positive threshold would silently pass every one.
    expect(classifySweepOutcome(d("2026-01-01"), -30, THRESHOLD)).toBe("drift-recorded");
  });
});

describe("only a completed, disagreeing read may refresh recency", () => {
  it("recorded may refresh; cleared and failed may not", () => {
    expect(mayRefreshRecency("drift-recorded")).toBe(true);
    // A cleared finding is closing, not refreshing.
    expect(mayRefreshRecency("drift-cleared")).toBe(false);
    // The whole of Defect 1: an unread page must not look freshly confirmed.
    expect(mayRefreshRecency("fetch-failed")).toBe(false);
  });
});
