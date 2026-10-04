/**
 * OPE-458 — the past-date gate judged a date the row was never stored with.
 *
 * `/api/suggest-event/submit` runs its past-date guard on `startDate`:
 *
 *     if (startDate && startDate.getTime() < Date.now()) {
 *       gateRoute = "PENDING_REVIEW";
 *       gateReasons.push("past_date");
 *     }
 *
 * …but ~180 lines later, a DISCONTINUOUS submission has its stored start date
 * recomputed from `event_days`:
 *
 *     effectiveStartDate = normalizeEventDate(sortedDates[0]);
 *
 * So a submission whose dates arrive only as `specificDates` was gated on a
 * null (or unrelated) value and then persisted with a past one.
 *
 * Live specimen, all three from one email on 2026-08-17:
 *
 *   b14b08ef  2024-06-15  no event_days   gate_flags ["end_date_in_past","past_date"]  ✓
 *   3ce10119  2024-12-07  no event_days   gate_flags ["end_date_in_past","past_date"]  ✓
 *   3fbf9829  2024-06-15  4 event_days    gate_flags NULL                              ✗
 *
 * The two that took the ordinary path were gated correctly. That is precisely
 * why this stayed invisible: the gate demonstrably works, on the rows that
 * reach it.
 *
 * These tests cover the ORDERING rule rather than the route (which needs D1,
 * auth and a live venue matcher): the decision must be made against the value
 * that gets written.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasCalendarDayPassed } from "@takemetothefair/datetime";

const SOURCE = readFileSync(resolve(__dirname, "..", "route.ts"), "utf8");

/**
 * Mirrors the guard with the SAME predicate the route calls (OPE-651: a
 * calendar-day comparison in the venue zone), so the intent is testable
 * independent of the route; the route's use of it is pinned below.
 */
function gateReasonsFor(effectiveStartDate: Date | null, now: number): string[] {
  const reasons: string[] = [];
  if (effectiveStartDate && hasCalendarDayPassed(effectiveStartDate, new Date(now)))
    reasons.push("past_date");
  return reasons;
}

const NOW = new Date("2026-08-18T00:00:00Z").getTime();

describe("the specimen that escaped", () => {
  it("gates a discontinuous submission on its FIRST event day", () => {
    // 3fbf9829: days spanning 2024-06-15 → 2024-12-08, sorted ascending.
    const days = ["2024-12-08", "2024-06-15", "2024-08-17", "2024-10-05"].sort();
    const effectiveStart = new Date(`${days[0]}T00:00:00Z`);
    expect(gateReasonsFor(effectiveStart, NOW)).toContain("past_date");
  });

  it("would NOT have gated on the incoming startDate alone", () => {
    // The failure this reproduces: nothing to judge at gate time.
    expect(gateReasonsFor(null, NOW)).toEqual([]);
  });

  it("still gates the two siblings that had no event_days", () => {
    for (const d of ["2024-06-15", "2024-12-07"]) {
      expect(gateReasonsFor(new Date(`${d}T00:00:00Z`), NOW)).toContain("past_date");
    }
  });
});

describe("future submissions are untouched", () => {
  it.each(["2026-09-15", "2027-03-19", "2029-08-09"])("does not gate %s", (d) => {
    expect(gateReasonsFor(new Date(`${d}T00:00:00Z`), NOW)).toEqual([]);
  });

  it("does not gate a discontinuous run that starts in the future", () => {
    const days = ["2026-12-05", "2026-09-12", "2026-10-10"].sort();
    expect(gateReasonsFor(new Date(`${days[0]}T00:00:00Z`), NOW)).toEqual([]);
  });
});

describe("the ordering rule, pinned in the route itself", () => {
  it("resolves gate flags AFTER the effective start date is computed", () => {
    // The whole defect was ordering: the decision must be made against the
    // value that gets written. If someone hoists these back above the
    // effectiveStartDate recompute, the gap silently returns.
    const effectiveIdx = SOURCE.indexOf("effectiveStartDate = normalizeEventDate(");
    const flagsIdx = SOURCE.indexOf("const gateFlagsJson =");
    const statusIdx = SOURCE.indexOf("const eventStatus =");
    expect(effectiveIdx).toBeGreaterThan(-1);
    expect(flagsIdx).toBeGreaterThan(effectiveIdx);
    expect(statusIdx).toBeGreaterThan(effectiveIdx);
  });

  it("re-checks the past date against effectiveStartDate", () => {
    expect(SOURCE).toContain(
      "effectiveStartDate && hasCalendarDayPassed(effectiveStartDate, new Date())"
    );
  });

  it("appends past_date idempotently, so a row gated earlier is unchanged", () => {
    // Both guards can fire on the same submission; the reason must not double.
    const reasons = ["past_date"];
    if (!reasons.includes("past_date")) reasons.push("past_date");
    expect(reasons).toEqual(["past_date"]);
    expect(SOURCE).toContain(
      'if (!gateReasons.includes("past_date")) gateReasons.push("past_date")'
    );
  });
});

/**
 * OPE-651 — the email/suggest lane stamped `past_date` on SAME-DAY rows.
 *
 * Dates are stored at noon UTC. `startDate.getTime() < Date.now()` therefore
 * called an event "past" from 12:00Z — 08:00 Eastern — on its own morning,
 * forcing PENDING_REVIEW on a fair that had not opened yet. #1102 fixed the
 * same instant comparison in the shared gate; this path kept its own copy.
 */
describe("a same-day submission is not past (OPE-651)", () => {
  const TODAY_NOON_UTC = new Date("2026-10-04T12:00:00Z");

  it.each([
    ["08:30 EDT, before doors", "2026-10-04T12:30:00Z"],
    ["16:00 EDT, mid-event", "2026-10-04T20:00:00Z"],
    ["23:30 EDT — already TOMORROW in UTC", "2026-10-05T03:30:00Z"],
  ])("does not gate at %s", (_label, now) => {
    expect(gateReasonsFor(TODAY_NOON_UTC, new Date(now).getTime())).toEqual([]);
  });

  it("does gate the next Eastern day", () => {
    expect(gateReasonsFor(TODAY_NOON_UTC, new Date("2026-10-05T04:30:00Z").getTime())).toEqual([
      "past_date",
    ]);
  });

  it("neither route site compares instants any more", () => {
    expect(SOURCE).not.toMatch(/[sS]tartDate\.getTime\(\) < Date\.now\(\)/);
    expect(SOURCE).toContain("startDate && hasCalendarDayPassed(startDate, new Date())");
  });
});
