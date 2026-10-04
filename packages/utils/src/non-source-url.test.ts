/**
 * OPE-1154 rework — map/search URLs are never evidence. Positives are the real
 * prod URLs (2026-10-04); negatives include the share.google link that resolves
 * to a real news article, and organizer pages whose PATH contains "maps".
 */
import { describe, expect, it } from "vitest";
import { isNonSourceUrl } from "./non-source-url";
import { gateDatesConfirmed } from "./dates-confirmed-gate";

describe("isNonSourceUrl", () => {
  it.each([
    // 0e39e183, the review specimen (captured as Google's consent wall)
    "https://www.google.com/maps/search/153+Hospital+Street%C2%A0+Augusta,+ME",
    // 070584e8, APPROVED, cited for name + both dates (08-29, no title captured)
    "https://www.google.com/maps/search/719+Cherry+Valley+Road,+Gilford?entry=ttu",
    "https://www.google.co.uk/maps/place/Augusta+Civic+Center",
    "https://maps.google.com/?q=Augusta+Civic+Center",
    "https://maps.app.goo.gl/AbCdEf123",
    "https://goo.gl/maps/xyz",
    "https://www.google.com/search?q=lilac+festival+augusta",
    "https://maps.apple.com/?q=Augusta",
    "https://www.bing.com/maps?q=Augusta",
  ])("is a non-source: %s", (url) => {
    expect(isNonSourceUrl(url)).toBe(true);
  });

  it.each([
    // resolves to a real article — judged by content, not host
    "https://share.google/VrKqiWtBJb2ZuJLOc",
    "http://joycescraftshows.com/",
    "https://events.humanitix.com/lilac-festival-planning-meeting",
    // an organizer page that merely has "maps" in its path
    "https://www.gunstock.com/maps/trail-map",
    "https://sites.google.com/view/vcs-holiday-market",
    "email://organizer@example.org",
    "",
    "not a url",
  ])("is NOT a non-source: %s", (url) => {
    expect(isNonSourceUrl(url)).toBe(false);
  });
});

describe("dates_confirmed gate — a map link cannot confirm a date", () => {
  const maps = {
    fieldName: "start_date",
    state: "active",
    sourceType: "other",
    sourceUrl: "https://www.google.com/maps/search/719+Cherry+Valley+Road,+Gilford",
  };
  const organizer = { ...maps, sourceUrl: "http://joycescraftshows.com/" };

  it("an existing map-only citation is refused, and the warning names the reason", () => {
    const r = gateDatesConfirmed({ requested: true, citations: [maps] });
    expect(r.value).toBe(false);
    expect(r.warning).toContain("map or search link");
  });

  it("a map link supplied in the same call is refused", () => {
    const r = gateDatesConfirmed({ requested: true, citations: [], callSource: maps });
    expect(r.value).toBe(false);
    expect(r.warning).toContain("map or search link");
  });

  it("control: an organizer citation beside it still confirms (070584e8's real shape)", () => {
    expect(gateDatesConfirmed({ requested: true, citations: [maps, organizer] }).value).toBe(true);
  });
});
