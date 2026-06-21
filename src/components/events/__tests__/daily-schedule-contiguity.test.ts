import { describe, it, expect } from "vitest";
import { isContiguousDaily } from "../DailyScheduleDisplay";
import type { EventDay } from "@/types";

// DQ-HOURS1 (2026-06-21): the "Daily:" simplified label must reflect ACTUAL
// date contiguity from event_days, not the discontinuous_dates flag. These
// guard that isContiguousDaily only returns true for a gap-free day-after-day
// run of OPEN days.
const day = (date: string, extra: Partial<EventDay> = {}): EventDay =>
  ({ id: date, date, openTime: "09:00", closeTime: "17:00", closed: false, ...extra }) as EventDay;

describe("isContiguousDaily", () => {
  it("true for a single day", () => {
    expect(isContiguousDaily([day("2026-07-04")])).toBe(true);
  });

  it("true for a gap-free consecutive run", () => {
    expect(isContiguousDaily([day("2026-07-04"), day("2026-07-05"), day("2026-07-06")])).toBe(true);
  });

  it("true regardless of input order (sorted internally)", () => {
    expect(isContiguousDaily([day("2026-07-06"), day("2026-07-04"), day("2026-07-05")])).toBe(true);
  });

  it("false for a Saturdays-only run (7-day gaps) — the bug case", () => {
    expect(isContiguousDaily([day("2026-06-06"), day("2026-06-13"), day("2026-06-20")])).toBe(
      false
    );
  });

  it("false for a single one-day gap", () => {
    expect(isContiguousDaily([day("2026-07-04"), day("2026-07-06")])).toBe(false);
  });

  it("true across a month boundary (Jul 31 -> Aug 1)", () => {
    expect(isContiguousDaily([day("2026-07-31"), day("2026-08-01")])).toBe(true);
  });

  it("false when an unparseable date is present (conservative)", () => {
    expect(isContiguousDaily([day("2026-07-04"), day("not-a-date")])).toBe(false);
  });
});
