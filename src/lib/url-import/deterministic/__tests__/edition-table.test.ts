/**
 * OPE-432 — the published-edition table, parsed deterministically.
 *
 * The fixture is the real page that produced the defect. Extraction returned
 * the right number of candidates and gave every one of them 2026 or no year,
 * so three future editions were dropped and reported to the submitter as
 * duplicates.
 *
 * These tests are about the YEAR dimension specifically: the page is the
 * authority on which editions exist, and the point of the module is that a
 * published table is machine-readable even when a model flattens it.
 */
import { describe, expect, it } from "vitest";
import { findEditionDates, findPublishedEditions } from "../edition-table";

/**
 * Verbatim from `marthasvineyardagriculturalsociety.org/the-fair`, including
 * the ordinals, the repeated weekday and month on both sides of the separator,
 * and the en-dashes — all of which are why `date-regex.ts` cannot read it.
 */
const MV_PAGE = `
  Fair Dates for 2026-2029
  Thursday, August 13th to Sunday, August 16th, 2026
  Thursday, August 12th–Sunday, August 15th, 2027
  Thursday, August 10th–Sunday, August 13th, 2028
  Thursday, August 9th–Sunday, August 12th, 2029
`;

describe("the Martha's Vineyard page — the fixture this ticket is named for", () => {
  it("recovers all four editions with their own years", () => {
    const editions = findPublishedEditions(MV_PAGE);

    expect(editions.map((e) => e.year)).toEqual([2026, 2027, 2028, 2029]);
    expect(editions.map((e) => e.startDate)).toEqual([
      "2026-08-13",
      "2027-08-12",
      "2028-08-10",
      "2029-08-09",
    ]);
    expect(editions.map((e) => e.endDate)).toEqual([
      "2026-08-16",
      "2027-08-15",
      "2028-08-13",
      "2029-08-12",
    ]);
  });

  it("invents nothing — 2024 appears nowhere, and must not appear here", () => {
    // A `2024-08-15 → 2024-08-18` row was written from this page. The year is
    // absent from the source (re-fetched to confirm: no archive, no past-year
    // content of any kind). Nothing this module returns may be un-sourced.
    const years = findEditionDates(MV_PAGE).map((e) => e.year);
    expect(years).not.toContain(2024);
    for (const e of findEditionDates(MV_PAGE)) {
      expect(MV_PAGE).toContain(String(e.year));
    }
  });

  it("is stable across repeated calls", () => {
    // A module-level /g regex carries `lastIndex` between calls, which would
    // make the second invocation silently return fewer editions than the first
    // — a bug that only shows up under real traffic.
    const first = findPublishedEditions(MV_PAGE);
    const second = findPublishedEditions(MV_PAGE);
    expect(second).toEqual(first);
    expect(second).toHaveLength(4);
  });
});

describe("formats organizers actually use", () => {
  it("reads a same-month range that writes the month once", () => {
    expect(findEditionDates("August 13 to 16, 2026")).toEqual([
      { startDate: "2026-08-13", endDate: "2026-08-16", year: 2026 },
    ]);
  });

  it("reads a cross-month range", () => {
    expect(findEditionDates("June 28 – July 5, 2026")).toEqual([
      { startDate: "2026-06-28", endDate: "2026-07-05", year: 2026 },
    ]);
  });

  it("reads abbreviated months and 'through'", () => {
    expect(findEditionDates("Sept 5 through Sept 7, 2027")).toEqual([
      { startDate: "2027-09-05", endDate: "2027-09-07", year: 2027 },
    ]);
  });

  it("handles a range that wraps the new year without inverting it", () => {
    // "December 30 – January 2, 2027" prints the END year. Taken literally the
    // range runs backwards; the start belongs to the previous year.
    expect(findEditionDates("December 30 – January 2, 2027")).toEqual([
      { startDate: "2026-12-30", endDate: "2027-01-02", year: 2026 },
    ]);
  });
});

describe("what it refuses to do", () => {
  it("returns nothing for a line with no year", () => {
    // The single most important negative. "August 13 to 16" with no year is
    // exactly where a default-to-current-year would come from, and defaulting
    // the year is the defect this ticket exists for.
    expect(findEditionDates("The fair runs August 13 to 16")).toEqual([]);
  });

  it("treats an ordinary single-edition page as needing no repair", () => {
    // One dated range is a normal event page. Returning it as a "published
    // edition table" would invite a caller to fan out from a single date.
    expect(findPublishedEditions("Cummington Fair — August 28 to 30, 2026")).toEqual([]);
  });

  it("does not mistake a phone number, ZIP or founding year for an edition", () => {
    const noise = `
      Call 508.693.9549 or write PO Box 73, 35 Panhandle Rd., West Tisbury, MA 02575.
      Founded in 1858. Adult admission 13-61 is $15; seniors 62+ pay $10.
    `;
    expect(findEditionDates(noise)).toEqual([]);
  });

  it("keeps only one edition per year — the earliest", () => {
    // A fair that also lists an unrelated event in the same year must not turn
    // that into a second edition of itself. The table supports the claim "the
    // annual edition is on these dates", and nothing more.
    const twoInOneYear = `
      August 13 to 16, 2026
      November 27 to 29, 2026
      August 12 to 15, 2027
    `;
    const editions = findPublishedEditions(twoInOneYear);
    expect(editions.map((e) => e.year)).toEqual([2026, 2027]);
    expect(editions[0].startDate).toBe("2026-08-13");
  });

  it("needs at least two distinct years, not two date lines", () => {
    // Two ranges in the same year is a two-day-weekend page, not a forward
    // schedule. `minYears` counts years, deliberately.
    const sameYearTwice = `
      August 13 to 16, 2026
      September 5 to 7, 2026
    `;
    expect(findPublishedEditions(sameYearTwice)).toEqual([]);
  });

  it("rejects impossible dates rather than rounding them", () => {
    expect(findEditionDates("February 30 to 31, 2026")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(findEditionDates("")).toEqual([]);
    expect(findPublishedEditions("")).toEqual([]);
  });
});
