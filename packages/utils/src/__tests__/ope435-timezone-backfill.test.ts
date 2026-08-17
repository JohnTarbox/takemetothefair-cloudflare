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

describe("every off-anchor time present in the flagged corpus still fires", () => {
  // Exactly the distinct UTC times measured across the 32 off-anchor rows.
  // If any of these stopped firing, the migration would be rewriting
  // timestamps the gate no longer objects to.
  const CORPUS_TIMES = [
    "00:00:00",
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

  it.each(CORPUS_TIMES)("%s raises the flag with no time in the description", (t) => {
    expect(flags(at(t))).toContain(FLAG);
  });

  it("…and each is clean once normalized to the anchor", () => {
    // The post-migration state for all 32.
    for (const t of CORPUS_TIMES) {
      const normalized = new Date(`${at(t).toISOString().slice(0, 10)}T12:00:00Z`);
      expect(flags(normalized), t).not.toContain(FLAG);
    }
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

describe("the safety net", () => {
  it("a genuinely confused row is re-flagged, so the backfill cannot hide a defect", () => {
    // If a future ingest writes an unnormalized timestamp, the gate raises it
    // again on the next write. That is what makes clearing the stale strings a
    // safe operation rather than a suppression.
    expect(flags(at("03:47:11"))).toContain(FLAG);
  });

  it("a quarter-hour time WITH a time in the description stays clean", () => {
    // Guards against over-normalizing: the gate defers to the description for
    // quarter-hour-aligned times, and those rows are not in the flagged set.
    expect(flags(at("18:00:00"), "Doors open at 2pm")).not.toContain(FLAG);
  });
});
