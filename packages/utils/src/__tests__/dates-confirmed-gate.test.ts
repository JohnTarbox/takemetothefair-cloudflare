/**
 * OPE-1200 — the pure dates_confirmed gate shared by the app and the MCP Worker.
 * The acceptance fixture: an aggregator import with no citation lands false.
 */
import { describe, expect, it } from "vitest";
import { gateDatesConfirmed } from "../dates-confirmed-gate";

const organizer = {
  fieldName: "start_date",
  state: "active",
  sourceType: "official_website",
  sourceUrl: "https://joycescraftshows.com/tanger",
};

describe("gateDatesConfirmed", () => {
  it("ACCEPTANCE: an aggregator import with no citation lands false, with a warning", () => {
    // What /api/admin/import writes for a new scraped row: scrapers report
    // true whenever a date parses, and a new row has no citations.
    const r = gateDatesConfirmed({ requested: true, citations: [] });
    expect(r).toMatchObject({ value: false, downgraded: true });
    expect(r.warning).toContain("dates_confirmed was written as false");
  });

  it("keeps true with a qualifying citation (the other side)", () => {
    expect(gateDatesConfirmed({ requested: true, citations: [organizer] })).toEqual({
      value: true,
      downgraded: false,
    });
  });

  it("keeps true with a qualifying source supplied in the same call", () => {
    const r = gateDatesConfirmed({
      requested: true,
      citations: [],
      callSource: { sourceType: "official_website", sourceUrl: organizer.sourceUrl },
    });
    expect(r.value).toBe(true);
  });

  it("requested false is never upgraded and never warns", () => {
    expect(gateDatesConfirmed({ requested: false, citations: [organizer] })).toEqual({
      value: false,
      downgraded: false,
    });
  });
});

describe("which existing citations qualify", () => {
  it.each([
    ["an aggregator host", { sourceUrl: "https://www.lakesregion.org/e/1" }],
    ["a community submission", { sourceType: "user_submitted" }],
    ["a stale citation", { state: "stale" }],
    ["an end_date citation", { fieldName: "end_date" }],
    ["a blank url", { sourceUrl: "  " }],
  ])("rejects %s", (_l, patch) => {
    const r = gateDatesConfirmed({ requested: true, citations: [{ ...organizer, ...patch }] });
    expect(r.value).toBe(false);
  });

  it("accepts an active organizer start_date citation", () => {
    expect(gateDatesConfirmed({ requested: true, citations: [organizer] }).value).toBe(true);
  });
});
