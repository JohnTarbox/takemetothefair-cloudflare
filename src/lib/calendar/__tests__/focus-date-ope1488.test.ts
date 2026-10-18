/**
 * OPE-1488 — one focus date across every calendar view.
 *
 * Each case is a path the ticket names: the URL date wins, Month → Day lands in the
 * month being viewed (not today), Day → Week/Month keeps the day, the legacy
 * `cal_date` still works, and "today" is the Eastern date (OPE-482).
 */
import { describe, expect, it } from "vitest";
import {
  dayViewHref,
  focusForMonth,
  focusForYear,
  longDateLabel,
  resolveFocusDate,
  todayEasternIso,
  validIsoDate,
  withFocus,
} from "../focus-date";
import { sortDayEntries } from "@/components/events/calendar-nav";

const TODAY = "2026-10-17";

describe("resolveFocusDate", () => {
  it("`date=` wins, so /events?view=calendar&cal_view=day&date=2026-10-24 opens on Oct 24", () => {
    expect(
      resolveFocusDate({ date: "2026-10-24", cal: "2026-12", cal_date: "2026-01-02" }, TODAY)
    ).toBe("2026-10-24");
  });
  it("the legacy cal_date still works", () => {
    expect(resolveFocusDate({ cal_date: "2026-11-05" }, TODAY)).toBe("2026-11-05");
  });
  it("Month view moved to November, then Day → November 1st, not today", () => {
    expect(resolveFocusDate({ cal: "2026-11" }, TODAY)).toBe("2026-11-01");
  });
  it("the current month focuses today", () => {
    expect(resolveFocusDate({ cal: "2026-10" }, TODAY)).toBe(TODAY);
  });
  it("a cal_year-only link focuses Jan 1 (or today in the current year)", () => {
    expect(resolveFocusDate({ cal_year: "2027" }, TODAY)).toBe("2027-01-01");
    expect(resolveFocusDate({ cal_year: "2026" }, TODAY)).toBe(TODAY);
  });
  it("rejects malformed and impossible dates, falling through to the next source", () => {
    expect(resolveFocusDate({ date: "2026-02-30", cal: "2026-03" }, TODAY)).toBe("2026-03-01");
    expect(resolveFocusDate({ date: "garbage" }, TODAY)).toBe(TODAY);
  });
});

describe("withFocus / dayViewHref", () => {
  it("writes date + a consistent cal/cal_year, drops cal_date and page, keeps filters", () => {
    const p = withFocus(
      {
        view: "calendar",
        cal_view: "month",
        cal: "2026-10",
        cal_date: "2026-01-01",
        page: "3",
        category: "Fairs",
        days: "weekend-any",
      },
      "2026-11-14",
      "week"
    );
    expect(Object.fromEntries(p)).toEqual({
      view: "calendar",
      cal_view: "week",
      cal: "2026-11",
      category: "Fairs",
      days: "weekend-any",
      date: "2026-11-14",
      cal_year: "2026",
    });
  });
  it("Month → clicking 20 → a Day-view URL containing cal_view=day&date=2026-10-20", () => {
    const href = dayViewHref(
      new URLSearchParams("view=calendar&cal_view=month&cal=2026-10"),
      "2026-10-20"
    );
    const u = new URL(href, "https://x.test");
    expect(u.pathname).toBe("/events");
    expect(u.searchParams.get("cal_view")).toBe("day");
    expect(u.searchParams.get("date")).toBe("2026-10-20");
  });
});

describe("helpers", () => {
  it("focusForMonth / focusForYear", () => {
    expect(focusForMonth("2026-10", TODAY)).toBe(TODAY);
    expect(focusForMonth("2026-12", TODAY)).toBe("2026-12-01");
    expect(focusForYear(2028, TODAY)).toBe("2028-01-01");
  });
  it("validIsoDate accepts real dates only", () => {
    expect(validIsoDate("2028-02-29")).toBe("2028-02-29");
    expect(validIsoDate("2026-02-29")).toBeNull();
    expect(validIsoDate(undefined)).toBeNull();
  });
  it("todayEasternIso is the New York date, not UTC (9pm EDT Saturday is still Saturday)", () => {
    expect(todayEasternIso(new Date("2026-10-18T01:00:00Z"))).toBe("2026-10-17");
    expect(todayEasternIso(new Date("2026-12-05T04:59:00Z"))).toBe("2026-12-04"); // 23:59 EST
    expect(todayEasternIso(new Date("2026-12-05T05:00:00Z"))).toBe("2026-12-05");
  });
  it("longDateLabel is the aria-label wording", () => {
    expect(longDateLabel("2026-10-20")).toBe("Tuesday, October 20, 2026");
  });
});

describe("sortDayEntries — the popover lists a day in time order", () => {
  const e = (start: string, allDay = false) => ({ allDay, occ: { start }, id: start });
  it("all-day first, then by start instant (8 AM before 5 PM)", () => {
    const sorted = sortDayEntries([
      e("2026-10-20T21:00:00Z"), // 5 PM EDT Juicy Market
      e("2026-10-20", true),
      e("2026-10-20T12:00:00Z"), // 8 AM EDT Brunswick
    ]);
    expect(sorted.map((x) => x.id)).toEqual([
      "2026-10-20",
      "2026-10-20T12:00:00Z",
      "2026-10-20T21:00:00Z",
    ]);
  });
});
