/**
 * OPE-1682 — the camps/workshops opt-in in the shared inclusion rule, and the
 * "registered" predicate that gates it.
 */
import { describe, expect, it } from "vitest";
import type { FeedEvent } from "../feeds/feed-event";
import {
  DEFAULT_INCLUSION_RULES,
  campsWorkshopsOptInActive,
  decideInclusion,
  isRegisteredPromoter,
} from "../feeds/inclusion";

const ev = (o: Partial<FeedEvent>): FeedEvent => ({
  externalId: "x",
  title: "Untitled",
  url: null,
  startDate: "2026-12-29",
  endDate: "2026-12-29",
  startTime: null,
  endTime: null,
  allDay: false,
  timezone: null,
  venue: null,
  organizerEmails: ["education@ohtm.example"],
  imageUrl: null,
  description: "Ages 8-12. Registration required.",
  categories: [],
  cost: null,
  statusCancelled: false,
  ...o,
});
const on = (o: Partial<FeedEvent>) =>
  decideInclusion(ev(o), DEFAULT_INCLUSION_RULES, { campsWorkshopsOptIn: true });
const off = (o: Partial<FeedEvent>) => decideInclusion(ev(o), DEFAULT_INCLUSION_RULES);

describe("OPE-1682 — decideInclusion with the opt-in", () => {
  it("acceptance: the camp from education@ is kept, Owls Nest is still dropped", () => {
    expect(on({ title: "Camp: Tinker and Test Team" })).toEqual({
      included: true,
      reason: "camp/workshop opt-in: title matches /\\bcamps?\\b/",
    });
    expect(on({ title: "Owls Nest: Magnet Exploration" }).included).toBe(false);
  });

  it("without the opt-in nothing changes", () => {
    expect(off({ title: "Camp: Tinker and Test Team" }).reason).toBe(
      "program title matches /\\bcamp\\b/"
    );
    expect(off({ title: "Pinstriping Workshop", description: "" }).reason).toMatch(/education@/);
    expect(on({ title: "Pinstriping Workshop", description: "" }).included).toBe(true);
    expect(
      decideInclusion(ev({ title: "Camp" }), DEFAULT_INCLUSION_RULES, {
        campsWorkshopsOptIn: false,
      }).included
    ).toBe(false);
  });

  it("matches title variants and TEC categories, not substrings", () => {
    expect(on({ title: "Summer Camps 2027" }).included).toBe(true);
    expect(on({ title: "Pinstriping Workshops" }).included).toBe(true);
    expect(on({ title: "Engine Rebuild", categories: ["Workshop"] }).reason).toBe(
      'camp/workshop opt-in: category "Workshop"'
    );
    expect(on({ title: "Engine Rebuild", categories: ["Vacation Camp"] }).included).toBe(true);
    // "Campbell" and "campus" are not camps.
    expect(on({ title: "Campbell Lecture" }).included).toBe(false);
    expect(on({ title: "Campus tour", categories: ["Campus"] }).included).toBe(false);
  });

  it("closures still drop first; other programs stay dropped", () => {
    expect(on({ title: "[Closed] Winter Camp day" }).reason).toMatch(/closure/);
    expect(on({ title: "STEM Saturdays: Rockets" }).included).toBe(false);
    expect(on({ title: "Junior Inventors" }).included).toBe(false);
  });
});

describe("OPE-1682 — registered gate", () => {
  it("registered = claimed with a linked user", () => {
    expect(isRegisteredPromoter({ claimed: true, userId: "u1" })).toBe(true);
    expect(isRegisteredPromoter({ claimed: true, userId: null })).toBe(false);
    expect(isRegisteredPromoter({ claimed: false, userId: "u1" })).toBe(false);
    expect(isRegisteredPromoter({ claimed: null, userId: null })).toBe(false);
  });

  it("the opt-in is active only when set AND registered", () => {
    expect(
      campsWorkshopsOptInActive({ includeCampsWorkshops: true, claimed: true, userId: "u" })
    ).toBe(true);
    expect(
      campsWorkshopsOptInActive({ includeCampsWorkshops: true, claimed: false, userId: "u" })
    ).toBe(false);
    expect(
      campsWorkshopsOptInActive({ includeCampsWorkshops: false, claimed: true, userId: "u" })
    ).toBe(false);
    expect(campsWorkshopsOptInActive(null)).toBe(false);
    expect(campsWorkshopsOptInActive(undefined)).toBe(false);
  });
});
