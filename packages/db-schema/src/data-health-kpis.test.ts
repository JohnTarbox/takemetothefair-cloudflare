import { describe, it, expect } from "vitest";
import {
  summarizeResolutions,
  snapshotAgeDays,
  isSnapshotStale,
  ADJUDICATED_STATUSES,
  SUPERSEDED_STATUSES,
} from "./data-health-kpis";

/**
 * The distribution measured on prod 2026-08-30, resolved within 28 days.
 * Real values, not invented ones — the whole point of the split is what this
 * particular shape does to a naive "everything not open is resolved" rule.
 */
const PROD_28D = [
  { status: "superseded_duplicate", count: 6574 },
  { status: "superseded_by_normalization", count: 226 },
  { status: "superseded_by_lifecycle", count: 194 },
  { status: "resolved_authoritative", count: 33 },
  { status: "self_resolved", count: 7 },
  { status: "resolved_divergent", count: 5 },
  { status: "dismissed", count: 7 },
  { status: "open", count: 264 },
];

describe("summarizeResolutions — the prod distribution (OPE-391)", () => {
  const s = summarizeResolutions(PROD_28D);

  it("separates adjudicated rows from bookkeeping closures", () => {
    expect(s.adjudicated).toBe(45); // 33 + 7 + 5
    expect(s.superseded).toBe(6994); // 6574 + 226 + 194
    expect(s.dismissed).toBe(7);
  });

  it("reports the honest coverage, not the flattering one", () => {
    // THE number this file exists for. 45/(45+7) = 0.865.
    expect(s.adjudicatedCoverage).toBeCloseTo(45 / 52, 6);
    // Under the legacy rule it is 7039/7046 — indistinguishable from perfect,
    // and 93% of that numerator is one bulk duplicate cleanup.
    expect(s.legacyCoverage).toBeCloseTo(7039 / 7046, 6);
    expect(s.legacyCoverage! - s.adjudicatedCoverage!).toBeGreaterThan(0.13);
  });

  it("reproduces the pre-OPE-391 resolved total EXACTLY", () => {
    // health-canary persists this into goodwill_health_snapshots.resolved_last_28d,
    // which holds 87 days of history under the old definition. If this drifts,
    // the stored trend silently stops being comparable with itself.
    expect(s.resolvedLegacy).toBe(6994 + 45);
    expect(s.resolvedLegacy).toBe(7039);
  });

  it("never counts an open row as resolved", () => {
    expect(s.adjudicated + s.superseded + s.dismissed).toBe(
      PROD_28D.reduce((a, r) => a + r.count, 0) - 264
    );
  });
});

describe("summarizeResolutions — edges", () => {
  it("returns NULL coverage, not 0, when nothing was adjudicated", () => {
    // B8: an empty denominator has no rate. Zero would read as "we were wrong
    // about everything", which is the opposite of the truth.
    const s = summarizeResolutions([{ status: "superseded_duplicate", count: 500 }]);
    expect(s.adjudicatedCoverage).toBeNull();
    expect(s.superseded).toBe(500);
  });

  it("does not let an unknown status inflate any coverage figure", () => {
    // A status added to the enum but not to this file must not silently land
    // in a bucket. Safe direction: it counts nowhere.
    const s = summarizeResolutions([
      { status: "resolved_authoritative", count: 3 },
      { status: "dismissed", count: 1 },
      { status: "resolved_by_some_future_mechanism", count: 999 },
    ]);
    expect(s.adjudicated).toBe(3);
    expect(s.superseded).toBe(0);
    expect(s.adjudicatedCoverage).toBeCloseTo(0.75, 6);
  });

  it("tolerates string counts and null statuses from the driver", () => {
    const s = summarizeResolutions([
      { status: "resolved_authoritative", count: "4" },
      { status: null, count: 10 },
    ]);
    expect(s.adjudicated).toBe(4);
  });

  it("keeps the two status lists disjoint", () => {
    // If a value appeared in both, the first branch would win silently and the
    // totals would still add up — a bug that hides inside a correct-looking sum.
    const overlap = (ADJUDICATED_STATUSES as readonly string[]).filter((v) =>
      (SUPERSEDED_STATUSES as readonly string[]).includes(v)
    );
    expect(overlap).toEqual([]);
  });
});

describe("snapshot freshness", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  it("measures age in whole UTC days", () => {
    expect(snapshotAgeDays("2026-08-30", now)).toBe(0);
    expect(snapshotAgeDays("2026-08-29", now)).toBe(1);
    expect(snapshotAgeDays("2026-08-25", now)).toBe(5);
  });

  it("treats a MISSING snapshot as stale, never fresh", () => {
    // The defect being guarded is "the writer stopped and every number froze".
    // A null that read as fresh would hide exactly that.
    expect(snapshotAgeDays(null, now)).toBeNull();
    expect(isSnapshotStale(null, now)).toBe(true);
    expect(isSnapshotStale(undefined, now)).toBe(true);
  });

  it("allows yesterday — the canary writes at a fixed UTC hour", () => {
    expect(isSnapshotStale("2026-08-30", now)).toBe(false);
    expect(isSnapshotStale("2026-08-29", now)).toBe(false);
    // Two days means it actually missed a night.
    expect(isSnapshotStale("2026-08-28", now)).toBe(false);
    expect(isSnapshotStale("2026-08-27", now)).toBe(true);
  });

  it("does not read a date string through local-timezone rules", () => {
    // A `new Date("2026-08-30")` comparison shifts by the host offset; the
    // suite runs TZ=UTC in CI but developers are on Eastern.
    const lateUtc = new Date("2026-08-30T23:59:59Z");
    const earlyUtc = new Date("2026-08-30T00:00:01Z");
    expect(snapshotAgeDays("2026-08-30", lateUtc)).toBe(0);
    expect(snapshotAgeDays("2026-08-30", earlyUtc)).toBe(0);
  });

  it("never reports a negative age for a future-dated snapshot", () => {
    expect(snapshotAgeDays("2026-09-05", now)).toBe(0);
  });
});
