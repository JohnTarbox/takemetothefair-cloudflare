/**
 * OPE-456 — the milestone chart was fed by forwarded email, not by our data.
 *
 * Row 18 stores `reached_date = 2026-08-17`, which is the date John forwarded
 * the mail. Google's body says "On Aug 15, 2026". A rolling 28-day sum over our
 * own `gsc_daily_totals` puts the 12,000 crossing at **2026-08-15** with 12,019
 * clicks — agreeing with Google against our stored value.
 *
 * Validation against the full history, before trusting the derivation at all:
 *
 *     13 of 13 rows with a stored date MATCH exactly (thresholds 40 → 7,000,
 *                                                     across five months)
 *      5 rows stored NULL and are now derivable
 *      1 row DIFFERS — id 18, the one this ticket is about
 *
 * 13/13 elsewhere is what makes the 14th credible.
 */
import { describe, expect, it } from "vitest";
import { deriveCrossings, auditStoredDates, type DailyTotal } from "../derive-gsc-milestones";

/** n days of `perDay` clicks starting at 2026-01-01. */
function series(n: number, perDay: number | ((i: number) => number)): DailyTotal[] {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    clicks: typeof perDay === "function" ? perDay(i) : perDay,
  }));
}

describe("a full window is required", () => {
  it("yields nothing when the series is shorter than the window", () => {
    // A partial window sums fewer days. Reporting a crossing off it would be a
    // date we cannot support — the exact failure this ticket is about.
    expect(deriveCrossings(series(27, 100), [100], 28)).toEqual([]);
  });

  it("reports the first FULL window, not the first day the total is reached", () => {
    const c = deriveCrossings(series(30, 10), [280], 28);
    expect(c).toHaveLength(1);
    // Day 28 (index 27) is the first complete window: 28 x 10 = 280.
    expect(c[0].reachedDate).toBe("2026-01-28");
    expect(c[0].windowTotal).toBe(280);
  });
});

describe("crossings", () => {
  it("records each threshold once, at its first crossing", () => {
    // A GROWING series — note a constant one has a constant trailing sum, so
    // it can never cross a second threshold. (My first fixture made exactly
    // that mistake and the test caught it.)
    const growing = series(60, (i) => i + 1); // 1, 2, 3, …
    // window at day 28 = sum(1..28) = 406; at day 29 = sum(2..29) = 434
    const c = deriveCrossings(growing, [406, 434], 28);
    expect(c.map((x) => x.threshold)).toEqual([406, 434]);
    expect(c[0].reachedDate).toBe("2026-01-28");
    expect(c[1].reachedDate).toBe("2026-01-29");
  });

  it("resolves several thresholds crossed on one day, in ascending order", () => {
    // A traffic spike can clear multiple badges at once.
    const spike = series(28, (i) => (i === 27 ? 5000 : 1));
    const c = deriveCrossings(spike, [1000, 2000, 3000], 28);
    expect(c.map((x) => x.threshold)).toEqual([1000, 2000, 3000]);
    expect(new Set(c.map((x) => x.reachedDate)).size).toBe(1);
  });

  it("omits a threshold never reached", () => {
    expect(deriveCrossings(series(40, 1), [10_000], 28)).toEqual([]);
  });

  it("carries the window total as evidence", () => {
    // A verdict without its supporting number is not auditable.
    const c = deriveCrossings(series(28, 100), [2000], 28);
    expect(c[0].windowTotal).toBe(2800);
  });

  it("is order-independent — unsorted input gives the same answer", () => {
    const s = series(30, 10);
    const shuffled = [...s].reverse();
    expect(deriveCrossings(shuffled, [280], 28)).toEqual(deriveCrossings(s, [280], 28));
  });

  it("handles a window that DROPS back below the threshold", () => {
    // A trailing sum can fall. The milestone is the FIRST crossing and must not
    // move or vanish afterwards.
    const rise = series(40, (i) => (i < 28 ? 100 : 0));
    const c = deriveCrossings(rise, [2800], 28);
    expect(c).toHaveLength(1);
    expect(c[0].reachedDate).toBe("2026-01-28");
  });
});

describe("auditing stored dates before correcting them", () => {
  const crossings = deriveCrossings(series(40, 10), [280, 290], 28);

  it("reports a match", () => {
    const a = auditStoredDates([{ threshold: 280, reachedDate: "2026-01-28" }], crossings);
    expect(a[0].verdict).toBe("match");
  });

  it("reports a difference with both values", () => {
    // The row-18 shape: stored two days late.
    const a = auditStoredDates([{ threshold: 280, reachedDate: "2026-01-30" }], crossings);
    expect(a[0]).toEqual({
      threshold: 280,
      stored: "2026-01-30",
      derived: "2026-01-28",
      verdict: "differs",
    });
  });

  it("distinguishes a stored NULL from a difference", () => {
    const a = auditStoredDates([{ threshold: 280, reachedDate: null }], crossings);
    expect(a[0].verdict).toBe("stored_null");
  });

  it("marks a threshold we cannot derive as underivable, not as a match", () => {
    // Absence of a derived date must never read as agreement.
    const a = auditStoredDates([{ threshold: 99_999, reachedDate: "2026-01-01" }], crossings);
    expect(a[0].verdict).toBe("underivable");
    expect(a[0].derived).toBeNull();
  });
});
