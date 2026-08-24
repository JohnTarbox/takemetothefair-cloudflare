/**
 * OPE-531 — a one-day event's hours must reach `event_days`.
 *
 * Specimen: inbound `a0e400a9` ("VCS Makers Market", 2026-08-23) states
 * "10 AM-3 PM" twice in the body. Event `c8648f70` has no `event_days` row,
 * so those hours are stored nowhere — `events` has no time columns.
 *
 * These import the real `singleDayWithHours` the route calls, rather than
 * mirroring the rule, so a change to the shipped function cannot leave them
 * green.
 */
import { describe, expect, it } from "vitest";
import { singleDayWithHours } from "../single-day-hours";

/** Matches `normalizeEventDate`, which anchors at noon UTC. */
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("singleDayWithHours", () => {
  it("synthesizes the specimen's day", () => {
    expect(
      singleDayWithHours({
        startDate: day("2026-09-12"),
        endDate: null,
        hasExplicitDays: false,
        startTime: "10:00",
        endTime: "15:00",
      })
    ).toBe("2026-09-12");
  });

  it("fires when the event has an explicit but identical end date", () => {
    expect(
      singleDayWithHours({
        startDate: day("2026-09-12"),
        endDate: day("2026-09-12"),
        hasExplicitDays: false,
        startTime: "10:00",
        endTime: "15:00",
      })
    ).toBe("2026-09-12");
  });

  it("fires on a half-known time range", () => {
    // An opening time with no stated close is still worth recording; DQ4's
    // flaggedForReview path then routes it for operator backfill.
    expect(
      singleDayWithHours({
        startDate: day("2026-09-12"),
        endDate: null,
        hasExplicitDays: false,
        startTime: "10:00",
        endTime: null,
      })
    ).toBe("2026-09-12");
    expect(
      singleDayWithHours({
        startDate: day("2026-09-12"),
        endDate: null,
        hasExplicitDays: false,
        startTime: null,
        endTime: "15:00",
      })
    ).toBe("2026-09-12");
  });

  it("does NOT spread one time range across a multi-day event", () => {
    // The OPE-465 direction. Asserting 10:00-15:00 on all three days of a
    // fair states per-day hours the source never gave.
    expect(
      singleDayWithHours({
        startDate: day("2026-09-12"),
        endDate: day("2026-09-14"),
        hasExplicitDays: false,
        startTime: "10:00",
        endTime: "15:00",
      })
    ).toBeNull();
  });

  it("yields to days the caller already supplied", () => {
    expect(
      singleDayWithHours({
        startDate: day("2026-09-12"),
        endDate: null,
        hasExplicitDays: true,
        startTime: "10:00",
        endTime: "15:00",
      })
    ).toBeNull();
  });

  it("creates nothing when no time is known", () => {
    // A row of two nulls tells a reader nothing and trips DQ4 for no gain.
    expect(
      singleDayWithHours({
        startDate: day("2026-09-12"),
        endDate: null,
        hasExplicitDays: false,
        startTime: null,
        endTime: null,
      })
    ).toBeNull();
  });

  it("creates nothing without a start date", () => {
    // The pre-fix state of the specimen itself: hours known, date null.
    expect(
      singleDayWithHours({
        startDate: null,
        endDate: null,
        hasExplicitDays: false,
        startTime: "10:00",
        endTime: "15:00",
      })
    ).toBeNull();
  });

  it("reads the calendar day from the noon anchor without drifting west", () => {
    // A midnight-UTC anchor would make this fragile; noon is why it is not.
    expect(
      singleDayWithHours({
        startDate: new Date("2026-01-01T12:00:00Z"),
        endDate: null,
        hasExplicitDays: false,
        startTime: "10:00",
        endTime: null,
      })
    ).toBe("2026-01-01");
  });
});
