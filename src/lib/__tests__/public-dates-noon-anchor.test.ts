/**
 * OPE-644 — public dates must be noon-anchored, or the page contradicts itself.
 *
 * `public_start_date` / `public_end_date` SHADOW start/end on the public event
 * page (`event.publicStartDate ?? event.startDate`). Date-only rendering is
 * Eastern, and midnight UTC is 20:00 the PREVIOUS day in Eastern — so a
 * midnight-anchored value renders the served band one day early at both ends
 * while the `Dates:` list on the same page, read straight off `event_days`,
 * stays correct.
 *
 * ⚠️ Run the suite as `TZ=UTC` (CI does). These assertions are about the UTC
 * anchor, and a host in Eastern can make a broken value look fine.
 */
import { describe, it, expect } from "vitest";
import { computePublicDates } from "@takemetothefair/utils";
import { formatDateRange, formatDate } from "@/lib/utils";

/** The exact live case: Three County Fair, Sep 4-7 2026. */
const THREE_COUNTY = [
  { date: "2026-09-04" },
  { date: "2026-09-05" },
  { date: "2026-09-06" },
  { date: "2026-09-07" },
];

describe("computePublicDates anchors at noon UTC", () => {
  it("returns noon, never midnight", () => {
    // Midnight is the defect. 43200s past midnight is the house convention.
    const { publicStartDate, publicEndDate } = computePublicDates(THREE_COUNTY);
    expect(publicStartDate!.getUTCHours()).toBe(12);
    expect(publicEndDate!.getUTCHours()).toBe(12);
    expect(publicStartDate!.toISOString()).toBe("2026-09-04T12:00:00.000Z");
    expect(publicEndDate!.toISOString()).toBe("2026-09-07T12:00:00.000Z");
  });

  it("excludes vendor-only days from the PUBLIC band", () => {
    const { publicStartDate } = computePublicDates([
      { date: "2026-09-03", vendorOnly: true },
      ...THREE_COUNTY,
    ]);
    expect(publicStartDate!.toISOString()).toBe("2026-09-04T12:00:00.000Z");
  });

  it("returns nulls when every day is vendor-only", () => {
    expect(computePublicDates([{ date: "2026-09-03", vendorOnly: true }])).toEqual({
      publicStartDate: null,
      publicEndDate: null,
    });
  });
});

describe("the rendered range agrees with the day list (the acceptance)", () => {
  it("renders Sep 4 - Sep 7, matching the first and last event_day", () => {
    // The live bug rendered "Thu, Sep 3, 2026 - Sun, Sep 6, 2026" against a day
    // list of Fri Sep 4 ... Mon Sep 7. This is that exact comparison.
    const { publicStartDate, publicEndDate } = computePublicDates(THREE_COUNTY);
    const rendered = formatDateRange(publicStartDate, publicEndDate);

    expect(rendered).toBe(`${formatDate("2026-09-04")} - ${formatDate("2026-09-07")}`);
    expect(rendered).toContain("Sep 4");
    expect(rendered).toContain("Sep 7");
    // The two days the bug actually printed.
    expect(rendered).not.toContain("Sep 3");
    expect(rendered).not.toContain("Sep 6, 2026 -");
  });

  it("a MIDNIGHT-anchored value renders a day early — the defect, pinned", () => {
    // Kept as the counter-example so the reason for the anchor is testable and
    // not just asserted in a comment. This is what 39 prod rows were doing.
    const midnight = formatDateRange(
      new Date("2026-09-04T00:00:00.000Z"),
      new Date("2026-09-07T00:00:00.000Z")
    );
    expect(midnight).toContain("Sep 3");
    expect(midnight).not.toContain("Sep 4");
  });
});
