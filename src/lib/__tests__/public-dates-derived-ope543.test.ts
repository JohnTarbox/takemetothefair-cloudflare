/**
 * OPE-543 — `public_*` is DERIVED, and NULL is a real answer.
 *
 * The ticket asked whether `public_start_date` is a writable override or a
 * denormalized mirror of `start_date`. It is neither, and the ambiguity was the
 * defect: `computePublicDates` derives it from `event_days` minus vendor-only
 * setup days, while every CREATE path *also* wrote it as a plain copy of
 * start/end whenever an event had no days — a copy nothing ever invalidated,
 * because `public_*` was recomputed only by the event_day write paths.
 *
 * These pin the contract the copy violated. The write-path half (recompute when
 * start_date moves, in both the admin PUT route and MCP `update_event`) is what
 * the production backfill in drizzle/0234 depends on to stay converged.
 */
import { describe, it, expect } from "vitest";
import { computePublicDates } from "../utils";

/** The noon anchor every event date uses (OPE-307 / drizzle/0232). */
const NOON = "T12:00:00.000Z";

describe("no days to derive from → NULL, not a copy", () => {
  it("returns nulls for an empty day list", () => {
    // This is the case the create paths used to fill with start/end. NULL is
    // what makes the value honest: there is no public span to report, and every
    // reader resolves it as `publicStartDate ?? startDate`.
    expect(computePublicDates([])).toEqual({ publicStartDate: null, publicEndDate: null });
  });

  it("returns nulls when EVERY day is vendor-only — the public attends nothing", () => {
    expect(
      computePublicDates([
        { date: "2026-08-26", vendorOnly: true },
        { date: "2026-08-27", vendorOnly: true },
      ])
    ).toEqual({ publicStartDate: null, publicEndDate: null });
  });
});

describe("with public days, the span is those days", () => {
  it("spans first to last public day, at the noon anchor", () => {
    const { publicStartDate, publicEndDate } = computePublicDates([
      { date: "2026-08-26" },
      { date: "2026-08-27" },
      { date: "2026-08-31" },
    ]);
    expect(publicStartDate?.toISOString()).toBe(`2026-08-26${NOON}`);
    expect(publicEndDate?.toISOString()).toBe(`2026-08-31${NOON}`);
  });

  it("is order-independent — days do not arrive sorted", () => {
    const { publicStartDate, publicEndDate } = computePublicDates([
      { date: "2026-08-31" },
      { date: "2026-08-26" },
      { date: "2026-08-27" },
    ]);
    expect(publicStartDate?.toISOString()).toBe(`2026-08-26${NOON}`);
    expect(publicEndDate?.toISOString()).toBe(`2026-08-31${NOON}`);
  });

  it("a single public day gives a same-day span, not a null end", () => {
    const { publicStartDate, publicEndDate } = computePublicDates([{ date: "2026-08-26" }]);
    expect(publicStartDate?.toISOString()).toBe(`2026-08-26${NOON}`);
    expect(publicEndDate?.toISOString()).toBe(`2026-08-26${NOON}`);
  });
});

describe("vendor-only days are excluded — the ONE case where divergence is correct", () => {
  it("a vendor-only setup day does not start the public span", () => {
    // 10 live events have vendor-only days. For them `public_start_date` SHOULD
    // differ from `start_date`, which is why the backfill re-derives rather than
    // flattening everything to start/end: that would erase a real distinction
    // while fixing an unrelated one.
    const { publicStartDate, publicEndDate } = computePublicDates([
      { date: "2026-08-25", vendorOnly: true }, // load-in
      { date: "2026-08-26" },
      { date: "2026-08-27" },
      { date: "2026-08-28", vendorOnly: true }, // strike
    ]);
    expect(publicStartDate?.toISOString()).toBe(`2026-08-26${NOON}`);
    expect(publicEndDate?.toISOString()).toBe(`2026-08-27${NOON}`);
  });

  it("treats a null/absent vendorOnly as public, not as vendor-only", () => {
    // `vendor_only` is nullable in D1; reading a NULL as "vendor-only" would
    // silently shrink the public span of every legacy row.
    const { publicStartDate } = computePublicDates([
      { date: "2026-08-26", vendorOnly: null },
      { date: "2026-08-27", vendorOnly: false },
    ]);
    expect(publicStartDate?.toISOString()).toBe(`2026-08-26${NOON}`);
  });
});

describe("the derivation is convergent, which is what makes the backfill replayable", () => {
  it("re-deriving from the same days gives the same answer", () => {
    const days = [
      { date: "2026-09-17" },
      { date: "2026-09-20" },
      { date: "2026-09-21", vendorOnly: true },
    ];
    expect(computePublicDates(days)).toEqual(computePublicDates(days));
  });
});
