/**
 * OPE-432 — the extractor invented a date range that appears nowhere on the page.
 *
 * `marthasvineyardagriculturalsociety.org/the-fair` publishes an explicit
 * four-year table (2026–2029). The intake produced a row dated
 * **2024-08-15 → 2024-08-18**. Re-fetching confirmed the page has no archive,
 * no past-year content, and no "2024" anywhere.
 *
 * A fabricated date is the one error class downstream cannot catch: it is
 * well-formed, passes every schema check, and looks exactly like a real date.
 * The source text is the only place it can be tested against.
 */
import { describe, expect, it } from "vitest";
import { groundDateInSource, yearsPresentInSource } from "../date-grounding";
import { extractMultipleEvents } from "../ai-extractor";

// The real page's date block, as the ticket quotes it.
const MV_PAGE = `
  Martha's Vineyard Agricultural Society
  Fair Dates for 2026-2029
  Thursday, August 13th to Sunday, August 16th, 2026
  Thursday, August 12th-Sunday, August 15th, 2027
  Thursday, August 10th-Sunday, August 13th, 2028
  Thursday, August 9th-Sunday, August 12th, 2029
  Admission: adult 13-61 $15, children 5-12 $10, senior 62+ $10
  PO Box 73, 35 Panhandle Rd., West Tisbury, MA 02575
  508.693.9549
`;

describe("the row that should never have been written", () => {
  it("rejects 2024, which appears nowhere on the page", () => {
    const r = groundDateInSource("2024-08-15", MV_PAGE, 2026);
    expect(r.verdict).toBe("fabricated");
    expect(r.year).toBe(2024);
  });

  it("accepts every year the page actually prints", () => {
    for (const y of [2026, 2027, 2028, 2029]) {
      expect(groundDateInSource(`${y}-08-13`, MV_PAGE, 2026).verdict).toBe("grounded");
    }
  });
});

describe("what must NOT be mistaken for a year", () => {
  it("ignores a zip code", () => {
    // "02575" is 5 digits, so the boundary guard excludes it; but a 4-digit zip
    // would otherwise sail through. This pins the non-digit boundary.
    expect(yearsPresentInSource("West Tisbury, MA 02575").has(2575)).toBe(false);
  });

  it("ignores digits inside a phone number", () => {
    expect(yearsPresentInSource("508.693.9549").size).toBe(0);
  });

  it("ignores a longer digit run", () => {
    expect(yearsPresentInSource("order 20265 shipped").has(2026)).toBe(false);
  });

  it("ignores an implausible year-shaped number", () => {
    // A $1500 booth fee or an id like 3021 is not a year.
    expect(yearsPresentInSource("booth fee 1500, ref 3021").size).toBe(0);
  });

  it("ignores 'Founded in 1858' boilerplate", () => {
    // Deliberately outside the 1900–2100 window. It costs nothing: no event
    // date is ever 1858, so collecting it could only ever ground a year that
    // could not be extracted in the first place.
    expect(yearsPresentInSource("Founded in 1858").has(1858)).toBe(false);
  });

  it("does collect a year at the low edge of the window", () => {
    // Guards the boundary itself, so a future tightening of the range is a
    // deliberate change rather than an accident.
    expect(yearsPresentInSource("est. 1900").has(1900)).toBe(true);
  });
});

describe("an absent year is graded, not automatically fatal", () => {
  const YEARLESS = "Come to the fair! August 15-18. Free parking.";

  it("treats a future year as an inference, not a fabrication", () => {
    // Plenty of real pages print "August 15-18" and leave the year implicit.
    // Defaulting to the current year there is reasonable; rejecting it would
    // lose legitimate submissions.
    const r = groundDateInSource("2026-08-15", YEARLESS, 2026);
    expect(r.verdict).toBe("inferred");
  });

  it("treats next year the same way", () => {
    expect(groundDateInSource("2027-08-15", YEARLESS, 2026).verdict).toBe("inferred");
  });

  it("but a PAST year is fabrication", () => {
    // This is the asymmetry that matters: a wrongly-kept future date is a
    // visible error an operator can fix from the listing. A fabricated PAST
    // date is silently filtered out of every forward-looking view, so nobody
    // ever sees it to correct it.
    expect(groundDateInSource("2024-08-15", YEARLESS, 2026).verdict).toBe("fabricated");
  });
});

describe("failing safe", () => {
  it("does not reject when there is no source text to check against", () => {
    // A fetch failure must not become a data-loss event.
    expect(groundDateInSource("2024-08-15", "", 2026).verdict).toBe("grounded");
    expect(groundDateInSource("2024-08-15", "   ", 2026).verdict).toBe("grounded");
  });

  it("passes through a null date", () => {
    expect(groundDateInSource(null, MV_PAGE, 2026).verdict).toBe("grounded");
    expect(groundDateInSource(undefined, MV_PAGE, 2026).verdict).toBe("grounded");
  });

  it("leaves an unparseable year to schema validation", () => {
    expect(groundDateInSource("not-a-date", MV_PAGE, 2026).verdict).toBe("grounded");
  });

  it("carries a reason on every verdict, for telemetry", () => {
    for (const d of ["2024-08-15", "2026-08-13", null]) {
      expect(groundDateInSource(d, MV_PAGE, 2026).reason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The pure-function tests above prove the RULE. These prove it is actually
 * WIRED — a check that exists but never runs is the recurring defect class in
 * this repo, and the reason the extractor shipped without one at all.
 */
describe("wired into extractMultipleEvents", () => {
  const md = {} as import("../types").PageMetadata;
  const mkAi = (resp: unknown) => ({ run: async () => resp }) as never;

  it("drops the fabricated 2024 range while keeping the event", async () => {
    const ai = mkAi({
      response: JSON.stringify([
        {
          name: "Martha's Vineyard Agricultural Fair",
          startDate: "2024-08-15",
          endDate: "2024-08-18",
        },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, MV_PAGE, md);

    // The grounding rule this test was written for still holds: the invented
    // 2024 range is gone, and no event on this page carries it.
    expect(events.map((e) => e.startDate)).not.toContain("2024-08-15");
    expect(events.every((e) => e.name?.includes("Martha's Vineyard"))).toBe(true);

    // The count changed with OPE-432's repair pass, and the change is the
    // point rather than a side effect. Grounding leaves the candidate with no
    // date at all; the page publishes four editions, so all four are restored
    // from the source table instead of one dateless row being written.
    expect(events).toHaveLength(5);
    expect(events.some((e) => e.startDate === null)).toBe(true);
    expect(events.map((e) => e.startDate).filter(Boolean)).toEqual([
      "2026-08-13",
      "2027-08-12",
      "2028-08-10",
      "2029-08-09",
    ]);
  });

  it("keeps a date the page really prints", async () => {
    const ai = mkAi({
      response: JSON.stringify([
        {
          name: "Martha's Vineyard Agricultural Fair 2028",
          startDate: "2028-08-10",
          endDate: "2028-08-13",
        },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, MV_PAGE, md);

    // Grounding keeps the model's 2028 dates — that is what this test is for.
    // It is no longer events[0] because OPE-432 restores the three editions
    // the model omitted and orders the result by date, so assert on the row
    // rather than on its position.
    const y2028 = events.find((e) => e.startDate === "2028-08-10");
    expect(y2028).toBeDefined();
    expect(y2028!.endDate).toBe("2028-08-13");

    // …and the omitted editions come back rather than being silently lost.
    expect(events.map((e) => e.startDate)).toEqual([
      "2026-08-13",
      "2027-08-12",
      "2028-08-10",
      "2029-08-09",
    ]);
  });

  it("keeps every edition of the multi-year table", async () => {
    // The shape the ticket wants preserved end-to-end. Grounding must not be
    // the thing that collapses them.
    const ai = mkAi({
      response: JSON.stringify([
        { name: "MV Fair 2026", startDate: "2026-08-13" },
        { name: "MV Fair 2027", startDate: "2027-08-12" },
        { name: "MV Fair 2028", startDate: "2028-08-10" },
        { name: "MV Fair 2029", startDate: "2029-08-09" },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, MV_PAGE, md);
    expect(events.map((e) => e.startDate)).toEqual([
      "2026-08-13",
      "2027-08-12",
      "2028-08-10",
      "2029-08-09",
    ]);
  });
});

/**
 * OPE-479 — the hours block must reach the extraction OUTPUT, not just parse.
 *
 * A parser nobody calls is the recurring defect in this repo (OPE-456 shipped
 * one; OPE-189 and OPE-405 were both silent no-ops). So this asserts the wiring
 * end-to-end through `extractMultipleEvents`, against the real page text.
 */
describe("OPE-479 — published hours reach the extracted candidates", () => {
  const md = {} as import("../types").PageMetadata;
  const mkAi = (resp: unknown) => ({ run: async () => resp }) as never;

  const PAGE_WITH_HOURS = `
    Fair Dates for 2026-2029
    Thursday, August 13th to Sunday, August 16th, 2026

    Fair Hours
    Thursday, Friday and Saturday: 10 AM to 11 PM
    Barn closes at 9 PM
    Sunday: 10 AM to 6 PM
    Carnival Opens at 11 AM each day of the Fair
  `;

  it("attaches per-day gate hours to the candidate", async () => {
    const ai = mkAi({
      response: JSON.stringify([
        { name: "Martha's Vineyard Agricultural Fair 2026", startDate: "2026-08-13" },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, PAGE_WITH_HOURS, md);

    const withHours = events.find((e) => (e.dayHours?.length ?? 0) > 0);
    expect(withHours).toBeDefined();

    const byDay = new Map(withHours!.dayHours!.map((d) => [d.weekday, d]));
    expect(byDay.get(4)).toMatchObject({ openTime: "10:00", closeTime: "23:00" }); // Thu
    expect(byDay.get(0)).toMatchObject({ openTime: "10:00", closeTime: "18:00" }); // Sun
  });

  it("does not let a building time become the fair's closing time", async () => {
    // The whole point. "Barn closes at 9 PM" sits between the Thu-Sat line and
    // the Sunday line; a naive parse would close the fair two hours early.
    const ai = mkAi({
      response: JSON.stringify([{ name: "MV Fair 2026", startDate: "2026-08-13" }]),
    });
    const { events } = await extractMultipleEvents(ai, PAGE_WITH_HOURS, md);
    const hours = events.find((e) => (e.dayHours?.length ?? 0) > 0)!.dayHours!;

    expect(hours.every((d) => d.closeTime !== "21:00")).toBe(true);
    expect(hours.find((d) => d.weekday === 4)!.notes.join(" ")).toContain("Barn closes at 9 PM");
  });

  it("leaves dayHours absent when the page publishes none", async () => {
    const ai = mkAi({
      response: JSON.stringify([{ name: "Some Fair 2026", startDate: "2026-08-13" }]),
    });
    const { events } = await extractMultipleEvents(ai, "August 13 to 16, 2026. Come see us!", md);
    expect(events.every((e) => !e.dayHours || e.dayHours.length === 0)).toBe(true);
  });
});
