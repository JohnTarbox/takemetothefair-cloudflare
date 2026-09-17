/**
 * OPE-456 — the milestones chart plots the date a milestone was REACHED.
 * Specimen (prod row 28): threshold 13000, reached_date 2026-08-19,
 * email_date 2026-08-24 (the forward). The chart drew it on Aug 24.
 */
import { describe, expect, it } from "vitest";
import { DERIVED_MILESTONE_SOURCE, toMilestonePoints } from "../milestone-points";

const BADGE = "google_search_console_email";

describe("toMilestonePoints", () => {
  it("plots reached_date, not the forward date (the 13K specimen)", () => {
    const [p] = toMilestonePoints([
      { threshold: 13000, reachedDate: "2026-08-19", emailDate: "2026-08-24", source: BADGE },
    ]);
    expect(p.date).toBe("2026-08-19");
    expect(p.date).not.toBe(p.emailDate); // landmark: the two really differ here
  });

  it("falls back to email_date only when no reached date exists", () => {
    const [p] = toMilestonePoints([
      { threshold: 500, reachedDate: null, emailDate: "2026-03-01", source: BADGE },
    ]);
    expect(p.date).toBe("2026-03-01");
  });

  it("orders by reached date, so the LATEST point is the most recently reached milestone", () => {
    // Real shape from 08-30: 17K reached 08-27 was ingested before 13K was forwarded (08-24 email).
    const pts = toMilestonePoints([
      { threshold: 17000, reachedDate: "2026-08-27", emailDate: "2026-08-30", source: BADGE },
      { threshold: 13000, reachedDate: "2026-08-19", emailDate: "2026-08-24", source: BADGE },
      {
        threshold: 16000,
        reachedDate: "2026-08-26",
        emailDate: "2026-08-30",
        source: DERIVED_MILESTONE_SOURCE,
      },
    ]);
    expect(pts.map((p) => p.threshold)).toEqual([13000, 16000, 17000]);
    expect(pts[pts.length - 1].date).toBe("2026-08-27");
    expect(pts.map((p) => p.derived)).toEqual([false, true, false]);
  });

  it("breaks a same-day tie by threshold", () => {
    const pts = toMilestonePoints([
      { threshold: 2000, reachedDate: "2026-06-01", emailDate: "2026-06-02", source: BADGE },
      { threshold: 1500, reachedDate: "2026-06-01", emailDate: "2026-06-02", source: BADGE },
    ]);
    expect(pts.map((p) => p.threshold)).toEqual([1500, 2000]);
  });
});
