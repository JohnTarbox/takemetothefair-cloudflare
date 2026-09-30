/**
 * OPE-1200 — the pure dates_confirmed gate shared by the app and the MCP Worker.
 * The acceptance fixture: an aggregator import with no citation lands false.
 */
import { describe, expect, it } from "vitest";
import {
  gateDatesConfirmed,
  isQualifyingDateCitation,
  organizerHostsFrom,
} from "../dates-confirmed-gate";

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

// OPE-1231 — Freeport Fall Festival: the organizer (Visit Freeport) publishes on
// visitfreeport.com, which is ALSO on the aggregator list. The organizer's own
// page must qualify; any other aggregator page must not.
describe("OPE-1231 — the promoter's own site is the organizer, even on an aggregator host", () => {
  const freeport = {
    fieldName: "start_date",
    state: "active",
    sourceType: "official_website",
    sourceUrl: "https://www.visitfreeport.com/freeport-fall-festival/",
  };
  const hosts = organizerHostsFrom(["https://www.visitfreeport.com"]);

  it("normalizes the promoter's website to a bare host", () => {
    expect(hosts).toEqual(["visitfreeport.com"]);
    expect(organizerHostsFrom([null, undefined, "", "not a url"])).toEqual([]);
  });

  it("the promoter's own page confirms the dates", () => {
    expect(
      gateDatesConfirmed({ requested: true, citations: [freeport], organizerHosts: hosts })
    ).toEqual({
      value: true,
      downgraded: false,
    });
  });

  it("DRIVEN TO FAILURE: without the promoter host it still downgrades — and now says why", () => {
    const g = gateDatesConfirmed({ requested: true, citations: [freeport] });
    expect(g.value).toBe(false);
    expect(g.warning).toContain("visitfreeport.com, an aggregator site");
    expect(g.warning).not.toContain("there is no active start_date citation");
  });

  it("an aggregator that is NOT this event's promoter still does not qualify", () => {
    const lakes = { ...freeport, sourceUrl: "https://www.lakesregion.org/events/some-fair" };
    expect(
      gateDatesConfirmed({ requested: true, citations: [lakes], organizerHosts: hosts }).value
    ).toBe(false);
  });

  it("a community submission on the promoter's host still does not qualify", () => {
    const sub = { ...freeport, sourceType: "user_submitted" };
    expect(
      gateDatesConfirmed({ requested: true, citations: [sub], organizerHosts: hosts }).value
    ).toBe(false);
  });

  it("with no citation at all it still downgrades with the original message", () => {
    const g = gateDatesConfirmed({ requested: true, citations: [], organizerHosts: hosts });
    expect(g.value).toBe(false);
    expect(g.warning).toContain("there is no active start_date citation");
  });

  it("isQualifyingDateCitation takes the same hosts (the sync-stale sweep's path)", () => {
    expect(isQualifyingDateCitation(freeport)).toBe(false);
    expect(isQualifyingDateCitation(freeport, hosts)).toBe(true);
  });
});
