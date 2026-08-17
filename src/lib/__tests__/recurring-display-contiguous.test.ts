/**
 * OPE-442 — "Every 1 days — 4 dates".
 *
 * A four-day contiguous fair (Thu 2026-08-13 → Sun 2026-08-16) rendered that
 * string above its day list. Three faults in one line: ungrammatical singular,
 * cadence language for something that has no cadence, and an internal
 * recurrence-expander concept leaking onto a public page.
 *
 * A 1-day interval is a RUN, not a cadence. The block directly above already
 * renders the full range, so the honest output is nothing at all.
 *
 * Same distinction OPE-47 drew for the "Daily" label — contiguity has to be
 * checked before cadence language is applied — surfacing in a different string.
 */
import { describe, expect, it } from "vitest";
import { inferCadence, cadenceLabel } from "../recurring-display";

const label = (dates: string[]) => cadenceLabel(inferCadence(dates), dates.length);

describe("a contiguous run is not a cadence", () => {
  const MV_FAIR = ["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"];

  it("classifies the reported 4-day fair as contiguous, not everyNDays", () => {
    expect(inferCadence(MV_FAIR)).toEqual({ kind: "contiguous", days: 4 });
  });

  it("renders NOTHING — the range header above already says it", () => {
    expect(label(MV_FAIR)).toBeNull();
  });

  it("never emits the ungrammatical string again", () => {
    expect(label(MV_FAIR) ?? "").not.toMatch(/Every 1 days/);
  });

  it.each([2, 3, 5, 10])("holds for a %i-day run", (n) => {
    const dates = Array.from({ length: n }, (_, i) =>
      new Date(Date.UTC(2026, 7, 13 + i)).toISOString().slice(0, 10)
    );
    expect(inferCadence(dates).kind).toBe("contiguous");
    expect(label(dates)).toBeNull();
  });
});

describe("genuine cadences are untouched", () => {
  it("still names a weekly market", () => {
    // Cadence language is useful HERE — this is the case it exists for.
    const saturdays = ["2026-06-06", "2026-06-13", "2026-06-20"];
    expect(label(saturdays)).toBe("Every Saturday — 3 dates");
  });

  it("still names alternating Saturdays", () => {
    expect(label(["2026-06-06", "2026-06-20", "2026-07-04"])).toBe(
      "Every other Saturday — 3 dates"
    );
  });

  it("still names a real every-N-days cadence", () => {
    // interval 3 — a genuine cadence, and grammatical.
    expect(label(["2026-06-01", "2026-06-04", "2026-06-07"])).toBe("Every 3 days — 3 dates");
  });

  it("still falls back to a bare count when intervals vary", () => {
    expect(label(["2026-06-01", "2026-06-03", "2026-06-08"])).toBe("3 dates");
  });

  it("still returns null for a single date", () => {
    expect(label(["2026-06-01"])).toBeNull();
  });
});

describe("the boundary between run and cadence", () => {
  it("a 2-day interval is a cadence, not a run", () => {
    // Only interval === 1 is contiguous. Off-by-one here would swallow real
    // every-other-day schedules into silence.
    expect(inferCadence(["2026-06-01", "2026-06-03", "2026-06-05"])).toEqual({
      kind: "everyNDays",
      days: 2,
    });
  });

  it("a run with one gap is NOT contiguous", () => {
    // Thu, Fri, then Sun — must not be silently described as a plain run.
    expect(inferCadence(["2026-08-13", "2026-08-14", "2026-08-16"]).kind).toBe("irregular");
  });
});
