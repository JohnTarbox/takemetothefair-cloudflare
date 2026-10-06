/**
 * OPE-1332 — a year-less day expression supports exactly ONE year.
 *
 * Specimen: inbound 64b2e93f (Viles Arboretum, forwarded 2026-10-03). The
 * extractor fanned it out to 2026-10-15 AND an invented 2027-10-15 — the day
 * from "planning meeting on October 15th", the year from "our 2027 Lilac
 * Festival". Both grounding checks passed it: `sourceNamesDay` matches
 * "October 15th" for any year, and the year check only asks whether 2027
 * appears anywhere in the text.
 */
import { describe, it, expect } from "vitest";
import {
  groundEventDates,
  impliedYearForYearlessDay,
  sourceNamesDayWithYear,
  yearlessDaySplitLosers,
} from "../field-grounding";

/** The real body text, as stored on inbound_emails.body_text_excerpt. */
const LILAC = `---------- Forwarded message ---------
From: Bethany Drouin <info@vilesarboretum.org>
Date: Sat, Oct 3, 2026 at 1:45 PM
Subject: Lilac Festival Planning Meeting

Happy Autumn!

We are beginning to plan our 2027 Lilac Festival. We're inviting vendors to
join our planning meeting on October 15th at 2pm. Your experience as a
vendor can help shape our event and ensure we provide a good experience for
both vendors and attendees.`;
const SENT = new Date("2026-10-03T17:45:00Z");

describe("sourceNamesDayWithYear", () => {
  it.each([
    ["2027-10-15", "Join us October 15, 2027 at the arboretum"],
    ["2027-10-15", "on Oct. 15th 2027"],
    ["2027-10-15", "15 October 2027"],
    ["2027-10-15", "15th Oct, 2027"],
    ["2027-10-15", "10/15/2027"],
    ["2027-10-15", "10-15-27"],
    ["2027-10-15", "2027-10-15"],
    ["2027-10-15", "October 15-16, 2027"],
    ["2027-05-02", "May 2 & 3, 2027"],
    ["2027-10-15", "Oct 15 – 17 2027"],
  ])("%s is stated WITH its year in %j", (iso, text) => {
    expect(sourceNamesDayWithYear(iso, text)).toBe(true);
  });

  it("the Lilac email states October 15th with NO year (the year 2027 is in another sentence)", () => {
    expect(sourceNamesDayWithYear("2027-10-15", LILAC)).toBe(false);
    expect(sourceNamesDayWithYear("2026-10-15", LILAC)).toBe(false);
  });
});

describe("impliedYearForYearlessDay", () => {
  it("an email sent 2026-10-03 saying 'October 15th' means 2026", () => {
    expect(impliedYearForYearlessDay("2027-10-15", SENT)).toBe(2026);
  });
  it("a day already well past rolls to next year ('May 16th' in October → 2027)", () => {
    expect(impliedYearForYearlessDay("2026-05-16", SENT)).toBe(2027);
  });
  it("a day just past (within 60 days) stays this year ('September 20th was a success')", () => {
    expect(impliedYearForYearlessDay("2026-09-20", SENT)).toBe(2026);
  });
  it("a March email naming December means the coming December", () => {
    expect(impliedYearForYearlessDay("2026-12-05", new Date("2026-03-10T12:00:00Z"))).toBe(2026);
  });
  it("…but a December day under 60 days past still means the one just gone", () => {
    // Jan 10: Dec 5 was 36 days ago — inside the lookback, like "September 20th
    // was a success" in October. Pinned so the window's edge is deliberate.
    expect(impliedYearForYearlessDay("2026-12-05", new Date("2026-01-10T12:00:00Z"))).toBe(2025);
  });
});

describe("groundEventDates — a borrowed year is PARTIAL, never dropped on its own", () => {
  it("2027-10-15 against the Lilac email: partial, with the reason naming the implied date", () => {
    const [r] = groundEventDates({
      startDate: "2027-10-15",
      sources: [LILAC],
      referenceDate: SENT,
    });
    expect(r.verdict).toBe("partial");
    expect(r.reason).toMatch(/means 2026-10-15/);
  });

  it("2026-10-15 against the same email: supported (unchanged)", () => {
    const [r] = groundEventDates({
      startDate: "2026-10-15",
      sources: [LILAC],
      referenceDate: SENT,
    });
    expect(r.verdict).toBe("supported");
  });

  it("an explicit year in the date expression is supported even a year out", () => {
    const [r] = groundEventDates({
      startDate: "2027-10-15",
      sources: ["Our next meeting: October 15, 2027."],
      referenceDate: SENT,
    });
    expect(r.verdict).toBe("supported");
  });

  it("the legitimate shape this must NOT drop: 'our 2027 show will be June 5th' sent in January 2026", () => {
    const [r] = groundEventDates({
      startDate: "2027-06-05",
      sources: ["Save the date! Our 2027 show will be June 5th."],
      referenceDate: new Date("2026-01-10T12:00:00Z"),
    });
    expect(r.verdict).toBe("partial"); // kept, lower confidence — not `unsupported`
  });
});

describe("yearlessDaySplitLosers — one phrase cannot be two dates", () => {
  it("the specimen: the 2027 twin of the 2026 meeting is the loser", () => {
    const candidates = [{ startDate: "2026-10-15" }, { startDate: "2027-10-15" }];
    expect(yearlessDaySplitLosers(candidates, [LILAC], SENT)).toEqual([1]);
  });

  it("order does not matter", () => {
    const candidates = [{ startDate: "2027-10-15" }, { startDate: "2026-10-15" }];
    expect(yearlessDaySplitLosers(candidates, [LILAC], SENT)).toEqual([0]);
  });

  it("a LONE candidate with a borrowed year is never refused here (no twin = no evidence)", () => {
    expect(yearlessDaySplitLosers([{ startDate: "2027-10-15" }], [LILAC], SENT)).toEqual([]);
  });

  it("two editions whose dates are stated WITH their years are both kept", () => {
    const text = "Meetings: October 15, 2026 and October 15, 2027.";
    const candidates = [{ startDate: "2026-10-15" }, { startDate: "2027-10-15" }];
    expect(yearlessDaySplitLosers(candidates, [text], SENT)).toEqual([]);
  });

  it("different days are never paired", () => {
    const candidates = [{ startDate: "2026-10-15" }, { startDate: "2027-10-16" }];
    expect(yearlessDaySplitLosers(candidates, [LILAC], SENT)).toEqual([]);
  });

  it("no source text captured → nothing refused (fail-safe)", () => {
    const candidates = [{ startDate: "2026-10-15" }, { startDate: "2027-10-15" }];
    expect(yearlessDaySplitLosers(candidates, [], SENT)).toEqual([]);
  });
});
