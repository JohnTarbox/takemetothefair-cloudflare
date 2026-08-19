/**
 * OPE-479 — the published Fair Hours block, parsed.
 *
 * The fixture is the real page, and the expected output is the hand repair
 * already live on `ce52e387` (the 2026 Martha's Vineyard edition): 4
 * `event_days`, Thu–Sat 10:00–23:00, Sun 10:00–18:00, with the building
 * closings and the 11 AM carnival open in per-day notes.
 *
 * The assertions that matter most are the ones about what does NOT become an
 * hour. `Barn closes at 9 PM` is not the fair closing at 9 PM, and a parser that
 * wrote it into `close_time` would publish a wrong closing time that looks
 * measured — the MDI failure (a plausible descending 10-5/10-4/10-3 invented
 * against a published flat 9-4) in a new place.
 */
import { describe, expect, it } from "vitest";
import { parseHoursBlock, applyHoursToDates, parseClockTime } from "../hours-block";

/** Verbatim from marthasvineyardagriculturalsociety.org/the-fair. */
const MV_HOURS = `
Fair Hours
Thursday, Friday and Saturday: 10 AM to 11 PM
Hall opens in the afternoon and closes at 10 PM
Barn closes at 9 PM
Fiber Tent closes at 5 PM
Sunday: 10 AM to 6 PM
Hall, Barn, and Fiber Tent close at 5 PM
Carnival Opens at 11 AM each day of the Fair
`;

describe("the Martha's Vineyard block — the fixture this ticket is named for", () => {
  const parsed = parseHoursBlock(MV_HOURS);

  it("yields four days with the published gate hours", () => {
    expect(parsed.map((d) => d.weekday)).toEqual([0, 4, 5, 6]); // Sun, Thu, Fri, Sat

    const byDay = new Map(parsed.map((d) => [d.weekday, d]));
    for (const wd of [4, 5, 6]) {
      expect(byDay.get(wd)!.openTime).toBe("10:00");
      expect(byDay.get(wd)!.closeTime).toBe("23:00");
    }
    // The Sunday short day — near-universal for multi-day fairs, and the reason
    // one range must never be applied across the whole run.
    expect(byDay.get(0)!.openTime).toBe("10:00");
    expect(byDay.get(0)!.closeTime).toBe("18:00");
  });

  it("keeps building times OUT of open/close", () => {
    // Hall 10 PM, Barn 9 PM, Fiber Tent 5 PM all appear on Thu-Sat. None of
    // them is the fair's closing time; all three would be wrong in close_time,
    // and the 5 PM one would be wrong by six hours.
    const thursday = parsed.find((d) => d.weekday === 4)!;
    expect(thursday.closeTime).toBe("23:00");
    expect(thursday.notes.join(" ")).toContain("Barn closes at 9 PM");
    expect(thursday.notes.join(" ")).toContain("Fiber Tent closes at 5 PM");
  });

  it("attaches each attraction line to the day group it followed", () => {
    const thursday = parsed.find((d) => d.weekday === 4)!;
    const sunday = parsed.find((d) => d.weekday === 0)!;

    // "Hall opens in the afternoon and closes at 10 PM" follows Thu-Sat.
    expect(thursday.notes.some((n) => n.includes("closes at 10 PM"))).toBe(true);
    // Sunday's own line is the combined 5 PM one, not Thursday's.
    expect(sunday.notes.some((n) => n.includes("Hall, Barn, and Fiber Tent close at 5 PM"))).toBe(
      true
    );
    expect(sunday.notes.some((n) => n.includes("Barn closes at 9 PM"))).toBe(false);
  });

  it("puts an 'each day' note on every day", () => {
    for (const day of parsed) {
      expect(day.notes.some((n) => n.includes("Carnival Opens at 11 AM"))).toBe(true);
    }
  });

  it("maps onto the 2026 run to give exactly 4 dated days", () => {
    // 2026-08-13 Thu → 2026-08-16 Sun. This is the row set live on ce52e387.
    const dated = applyHoursToDates(parsed, "2026-08-13", "2026-08-16");
    expect(dated.map((d) => d.date)).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
    expect(dated.map((d) => `${d.openTime}-${d.closeTime}`)).toEqual([
      "10:00-23:00",
      "10:00-23:00",
      "10:00-23:00",
      "10:00-18:00",
    ]);
  });
});

describe("parseClockTime", () => {
  it("reads the forms organizers write", () => {
    expect(parseClockTime("10 AM")).toBe("10:00");
    expect(parseClockTime("6:30pm")).toBe("18:30");
    expect(parseClockTime("11 P.M.")).toBe("23:00");
    expect(parseClockTime("12 AM")).toBe("00:00"); // midnight, not noon
    expect(parseClockTime("12 PM")).toBe("12:00"); // noon, not midnight
  });

  it("returns null rather than a plausible wrong time", () => {
    expect(parseClockTime("25 PM")).toBeNull();
    expect(parseClockTime("10:99 AM")).toBeNull();
    expect(parseClockTime("sometime in the afternoon")).toBeNull();
  });
});

describe("what it refuses to invent", () => {
  it("returns nothing for text with no day-scoped hours", () => {
    expect(parseHoursBlock("The fair runs all weekend. Come see us!")).toEqual([]);
    expect(parseHoursBlock("")).toEqual([]);
    expect(parseHoursBlock(null)).toEqual([]);
  });

  it("does not interpolate a day the organizer did not publish", () => {
    // Only Saturday is published; a Fri-Sun run must NOT gain Friday and Sunday
    // hours by assuming they match. This is the MDI failure exactly.
    const parsed = parseHoursBlock("Saturday: 9 AM to 4 PM");
    const dated = applyHoursToDates(parsed, "2026-08-14", "2026-08-16"); // Fri-Sun
    expect(dated).toHaveLength(1);
    expect(dated[0].date).toBe("2026-08-15");
  });

  it("does not treat a bare attraction line as the fair's hours", () => {
    // No weekday-scoped gate hours anywhere — so there is nothing to publish,
    // even though the text contains a perfectly parseable time.
    expect(parseHoursBlock("Barn closes at 9 PM")).toEqual([]);
  });

  it("returns nothing when the date range is inverted or unparseable", () => {
    const parsed = parseHoursBlock(MV_HOURS);
    expect(applyHoursToDates(parsed, "2026-08-16", "2026-08-13")).toEqual([]);
    expect(applyHoursToDates(parsed, "not-a-date", "2026-08-16")).toEqual([]);
  });
});

describe("shapes other organizers use", () => {
  it("reads a single-day fair", () => {
    const p = parseHoursBlock("Saturday: 9 AM to 4 PM");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ weekday: 6, openTime: "09:00", closeTime: "16:00" });
  });

  it("reads abbreviated weekdays", () => {
    const p = parseHoursBlock("Fri: 5 PM to 10 PM\nSat: 10 AM to 10 PM");
    expect(p.map((d) => d.weekday)).toEqual([5, 6]);
    expect(p[0].openTime).toBe("17:00");
  });

  it("lets a later line for the same day correct an earlier one", () => {
    const p = parseHoursBlock("Sunday: 10 AM to 6 PM\nSunday: 10 AM to 5 PM");
    expect(p).toHaveLength(1);
    expect(p[0].closeTime).toBe("17:00");
  });
});
