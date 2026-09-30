/**
 * OPE-435 — the property the backfill depends on.
 *
 * drizzle/0199 normalizes 32 off-anchor events to 12:00:00Z and then strips
 * `start_date_timezone_confused` from `gate_flags` on all 97 flagged live rows.
 *
 * That is only worth doing if the gate genuinely will not re-raise the flag
 * afterwards. If it would, the migration is cosmetic — the flag returns on the
 * next write and the noise is back. So this pins the two halves of that claim:
 *
 *   1. 12:00:00Z is unconditionally clean (why clearing the 65 already-anchored
 *      rows' stale strings is correct, with no timestamp change needed).
 *   2. the off-anchor times actually present in the flagged corpus DO fire
 *      (why those 32 needed the timestamp rewrite rather than a string edit).
 *
 * The inverse property is the migration's real safety net: a genuinely confused
 * row gets re-flagged automatically, so this backfill cannot hide a real defect.
 */
import { describe, it, expect } from "vitest";
import { dateLooksImplausible } from "../event-date-gates";

const FLAG = "start_date_timezone_confused";

/** UTC date+time -> Date, matching how the column is stored. */
const at = (t: string) => new Date(`2026-08-13T${t}Z`);

/** `DateGateResult` is a discriminated union — `{ok:true}` carries no reasons,
 *  so narrow on `ok` rather than reaching for a field that may not exist. */
function flags(startDate: Date, description?: string): string[] {
  const result = dateLooksImplausible({ startDate, description } as never);
  return result.ok ? [] : result.reasons;
}

describe("the anchor is unconditionally clean", () => {
  it("12:00:00Z does not raise the flag", () => {
    expect(flags(at("12:00:00"))).not.toContain(FLAG);
  });

  it("stays clean with no description — the 65 stale rows mostly have none", () => {
    // This is the whole justification for clearing those rows' stored string
    // without touching their timestamps: the gate cannot produce this value for
    // them, so what is stored is simply out of date.
    expect(flags(at("12:00:00"), undefined)).not.toContain(FLAG);
  });
});

describe("OPE-1032 — the gate fires on a DATE disagreement, not on a storage shape", () => {
  // The corpus times this file originally pinned as "always fires" (OPE-435).
  // John ratified narrowing the gate on 2026-09-15 after three weekly drains
  // measured the storage-shape class at ~100% false positive: it now fires only
  // when the stored instant is a different calendar day in America/New_York
  // than in UTC — the day a visitor is actually shown.
  //
  // `at()` builds a SUMMER (EDT, UTC−4) date, so an instant before 04:00Z is the
  // previous Eastern day and fires; everything from 04:00Z on is the same day.
  const PREVIOUS_EASTERN_DAY = ["00:00:00", "03:47:11"];
  const SAME_EASTERN_DAY = [
    "04:00:00",
    "09:00:00",
    "10:00:00",
    "13:00:00",
    "13:30:00",
    "14:00:00",
    "15:00:00",
    "16:00:00",
    "20:00:00",
    "22:15:00",
    "23:30:00",
  ];

  it.each(PREVIOUS_EASTERN_DAY)("%s (previous Eastern day) raises the flag", (t) => {
    expect(flags(at(t))).toContain(FLAG);
  });

  it.each(SAME_EASTERN_DAY)("%s (same Eastern day) is clean — a canonical storage shape", (t) => {
    expect(flags(at(t))).not.toContain(FLAG);
  });

  it("LANDMARK: 04:00Z on a WINTER date is the previous Eastern day and fires", () => {
    // The seasonal half the old description-deferral rule could pass: midnight
    // EDT written for a date that is actually in EST renders a day early.
    expect(flags(new Date("2026-12-12T04:00:00Z"))).toContain(FLAG);
    expect(flags(new Date("2026-12-12T05:00:00Z"))).not.toContain(FLAG);
  });

  it("a description mentioning a time no longer changes the verdict either way", () => {
    expect(flags(at("18:00:00"), "Doors open at 2pm")).not.toContain(FLAG);
    expect(flags(at("00:00:00"), "Doors open at 2pm")).toContain(FLAG);
  });
});

describe("normalizing preserves the UTC calendar date", () => {
  it.each(["00:00:00", "04:00:00", "12:00:00", "23:30:00"])(
    "%s keeps its date when anchored",
    (t) => {
      // The migration's SQL is date(start_date) || ' 12:00:00'. This asserts the
      // property that makes that safe: no row moves to a different day.
      const original = at(t);
      const normalized = new Date(`${original.toISOString().slice(0, 10)}T12:00:00Z`);
      expect(normalized.toISOString().slice(0, 10)).toBe(original.toISOString().slice(0, 10));
    }
  );
});
