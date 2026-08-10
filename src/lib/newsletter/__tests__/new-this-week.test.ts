/**
 * OPE-191 — the past-date guard is the load-bearing bit (the ticket says
 * lifecycle_status alone let dead events through), so the date-boundary helpers
 * are pinned here. The full query is exercised in integration; these lock the
 * pure boundaries the SQL is built from.
 */
import { describe, it, expect } from "vitest";
import { startOfUtcDay, weekAgo, datesAreUnconfirmed } from "../new-this-week";

describe("selection boundaries", () => {
  it("startOfUtcDay drops the time — an event earlier today still counts", () => {
    const d = startOfUtcDay(new Date("2026-07-16T18:30:00Z"));
    expect(d.toISOString()).toBe("2026-07-16T00:00:00.000Z");
  });

  it("weekAgo is exactly 7 days before now", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    expect(weekAgo(now).toISOString()).toBe("2026-07-09T12:00:00.000Z");
  });
});

describe("datesAreUnconfirmed (OPE-360)", () => {
  it("IGNORES status — a TENTATIVE show with confirmed dates is not TBC", () => {
    // The reported bug, as an assertion. Celebrate Craft Holiday Fair is
    // TENTATIVE only because it lacks an image and a price; its dates are
    // confirmed and verified against the organiser's site. Keying off status
    // told exhibitors "Dates TBC" for a show with locked dates.
    expect(
      datesAreUnconfirmed({
        datesConfirmed: true,
        status: "TENTATIVE",
        lifecycleStatus: "TENTATIVE",
      })
    ).toBe(false);
  });

  it("marks a show TBC only on an explicit dates_confirmed = false", () => {
    expect(datesAreUnconfirmed({ datesConfirmed: false, status: "APPROVED" })).toBe(true);
  });

  it("treats NULL as confirmed, matching the column default", () => {
    // dates_confirmed defaults to true; an older row that never set it should
    // not suddenly read as uncertain.
    expect(datesAreUnconfirmed({ datesConfirmed: null, status: "APPROVED" })).toBe(false);
  });

  it("an APPROVED show with unconfirmed dates IS TBC — the flag cuts both ways", () => {
    expect(datesAreUnconfirmed({ datesConfirmed: false, status: "APPROVED" })).toBe(true);
  });
});
