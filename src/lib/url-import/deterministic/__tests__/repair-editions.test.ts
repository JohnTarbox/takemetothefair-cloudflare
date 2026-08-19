/**
 * OPE-432 — the repair pass, and the cases where it must refuse.
 *
 * The refusals matter more than the repair. A pass that fabricates editions on
 * a directory page is strictly worse than the defect it fixes: losing an event
 * is recoverable by re-submitting, inventing one puts a fair on the site that
 * does not exist. So most of this file is negative cases.
 */
import { describe, expect, it } from "vitest";
import { repairFlattenedEditions } from "../repair-editions";
import type { ExtractedEvent } from "../../types";

const MV_PAGE = `
  Fair Dates for 2026-2029
  Thursday, August 13th to Sunday, August 16th, 2026
  Thursday, August 12th–Sunday, August 15th, 2027
  Thursday, August 10th–Sunday, August 13th, 2028
  Thursday, August 9th–Sunday, August 12th, 2029
`;

function candidate(over: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    _extractId: "c0",
    name: "Martha's Vineyard Agricultural Fair 2026",
    description: "The Island's agricultural fair.",
    startDate: "2026-08-13",
    endDate: "2026-08-16",
    startTime: "10:00",
    endTime: "23:00",
    hoursVaryByDay: true,
    hoursNotes: "Sunday closes at 6 PM",
    specificDates: null,
    venueName: "Agricultural Hall",
    venueAddress: "35 Panhandle Rd.",
    venueCity: "West Tisbury",
    venueState: "MA",
    isStatewide: false,
    stateCode: "MA",
    ticketUrl: null,
    ticketPriceMin: 1500,
    ticketPriceMax: 1500,
    imageUrl: null,
    categories: ["AGRICULTURAL_FAIR"],
    vendorFeeMin: null,
    vendorFeeMax: null,
    vendorFeeNotes: null,
    indoorOutdoor: "MIXED",
    estimatedAttendance: null,
    applicationUrl: null,
    applicationDeadline: "2026-06-01",
    applicationInstructions: null,
    walkInsAllowed: null,
    ...over,
  };
}

describe("the flattened extraction this ticket is named for", () => {
  it("rebuilds 2027/2028/2029 from the source when every candidate said 2026", () => {
    // The real shape: five candidates, all the same name, all 2026 or undated.
    const flattened = [
      candidate({ _extractId: "c0" }),
      candidate({ _extractId: "c1", startDate: null, endDate: null }),
      candidate({ _extractId: "c2", name: "Martha's Vineyard Agricultural Fair" }),
    ];

    const { events, repairedYears } = repairFlattenedEditions(flattened, MV_PAGE);

    expect(repairedYears).toEqual([2027, 2028, 2029]);
    const rebuilt = events.filter((e) => !flattened.includes(e));
    expect(rebuilt.map((e) => e.startDate)).toEqual(["2027-08-12", "2028-08-10", "2029-08-09"]);
    expect(rebuilt.map((e) => e.endDate)).toEqual(["2027-08-15", "2028-08-13", "2029-08-12"]);
  });

  it("gives each rebuilt edition its own year in the name", () => {
    // Two rows a year apart with byte-identical names is how the ack came to
    // report distinct editions as duplicates of one another.
    const { events } = repairFlattenedEditions([candidate()], MV_PAGE);
    const names = events.map((e) => e.name);
    expect(names).toContain("Martha's Vineyard Agricultural Fair 2027");
    expect(names).toContain("Martha's Vineyard Agricultural Fair 2029");
    expect(new Set(names).size).toBe(names.length);
  });

  it("quotes the dates but drops every time-of-day field", () => {
    // The dates are on the page. The hours are an inference from a different
    // year — the MDI incident was invented hours of exactly this shape.
    const { events } = repairFlattenedEditions([candidate()], MV_PAGE);
    const rebuilt = events.find((e) => e.startDate === "2029-08-09")!;

    expect(rebuilt.startTime).toBeNull();
    expect(rebuilt.endTime).toBeNull();
    expect(rebuilt.hoursNotes).toBeNull();
    expect(rebuilt.hoursVaryByDay).toBe(false);
    expect(rebuilt.applicationDeadline).toBeNull();

    // …while the recurring identity of the event is carried over.
    expect(rebuilt.venueAddress).toBe("35 Panhandle Rd.");
    expect(rebuilt.venueCity).toBe("West Tisbury");
    expect(rebuilt.categories).toEqual(["AGRICULTURAL_FAIR"]);
  });

  it("copies from the best-populated candidate, not merely the first", () => {
    const thin = candidate({
      _extractId: "thin",
      venueAddress: null,
      venueCity: null,
      description: null,
      categories: null,
    });
    const rich = candidate({ _extractId: "rich" });

    const { events } = repairFlattenedEditions([thin, rich], MV_PAGE);
    const rebuilt = events.find((e) => e.startDate === "2028-08-10")!;
    expect(rebuilt.venueCity).toBe("West Tisbury");
  });

  it("returns editions in date order", () => {
    const { events } = repairFlattenedEditions([candidate()], MV_PAGE);
    const dates = events.map((e) => e.startDate);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("what it refuses to repair", () => {
  it("does nothing when the candidates already cover every published year", () => {
    const complete = [
      candidate({ _extractId: "a", startDate: "2026-08-13" }),
      candidate({ _extractId: "b", startDate: "2027-08-12" }),
      candidate({ _extractId: "c", startDate: "2028-08-10" }),
      candidate({ _extractId: "d", startDate: "2029-08-09" }),
    ];
    const { events, repairedYears } = repairFlattenedEditions(complete, MV_PAGE);
    expect(repairedYears).toEqual([]);
    expect(events).toBe(complete);
  });

  it("refuses a directory page listing DIFFERENT events", () => {
    // The dangerous case. A page with many fairs also has many dated ranges
    // across several years. Cloning one fair's venue and fees onto another
    // fair's dates would fabricate events rather than recover them.
    const directory = [
      candidate({ _extractId: "a", name: "Cummington Fair 2026", startDate: "2026-08-13" }),
      candidate({ _extractId: "b", name: "Topsham Fair 2026", startDate: "2026-08-13" }),
    ];
    const { events, repairedYears } = repairFlattenedEditions(directory, MV_PAGE);
    expect(repairedYears).toEqual([]);
    expect(events).toBe(directory);
  });

  it("does nothing when the source publishes only one year", () => {
    const { repairedYears } = repairFlattenedEditions(
      [candidate()],
      "Cummington Fair — August 28 to 30, 2026"
    );
    expect(repairedYears).toEqual([]);
  });

  it("does nothing without source text — a fetch failure must not become a data event", () => {
    const input = [candidate()];
    expect(repairFlattenedEditions(input, "").events).toBe(input);
    expect(repairFlattenedEditions(input, "").repairedYears).toEqual([]);
  });

  it("does nothing with no candidates at all", () => {
    // Zero candidates means extraction failed outright. Synthesising four
    // editions from a date table with no name, venue or description behind
    // them would be inventing an event from a calendar.
    const { events, repairedYears } = repairFlattenedEditions([], MV_PAGE);
    expect(events).toEqual([]);
    expect(repairedYears).toEqual([]);
  });

  it("treats an unnamed candidate as no evidence of a second event", () => {
    // A null name is a gap in the extraction, not a different fair — so it
    // must not veto the repair the way a genuinely different name does.
    const withBlank = [candidate(), candidate({ _extractId: "blank", name: null })];
    const { repairedYears } = repairFlattenedEditions(withBlank, MV_PAGE);
    expect(repairedYears).toEqual([2027, 2028, 2029]);
  });

  it("matches names across ordinal and 'Annual' noise", () => {
    // "38th Annual X 2026" and "X" are the same fair; a stricter key would
    // read them as two events and silently skip the repair.
    const noisy = [
      candidate({ _extractId: "a", name: "38th Annual Martha's Vineyard Agricultural Fair 2026" }),
      candidate({ _extractId: "b", name: "Martha's Vineyard Agricultural Fair" }),
    ];
    const { repairedYears } = repairFlattenedEditions(noisy, MV_PAGE);
    expect(repairedYears).toEqual([2027, 2028, 2029]);
  });
});
