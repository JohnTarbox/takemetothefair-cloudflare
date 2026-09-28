/**
 * OPE-1201 item 3 — duplicate-venue candidates. Snowport is the acceptance
 * fixture (its real names, city and approximate coordinates); the negatives are
 * the false-positive shapes the token rules exist for.
 */
import { describe, expect, it } from "vitest";
import {
  haversineMeters,
  planVenueNearPairs,
  type VenueRowForNear,
} from "../venue-near-duplicates";

const v = (p: Partial<VenueRowForNear> & { id: string; name: string }): VenueRowForNear => ({
  city: "Boston",
  state: "MA",
  latitude: null,
  longitude: null,
  ...p,
});

describe("planVenueNearPairs", () => {
  it("ACCEPTANCE: detects the Snowport pair (two names, one place)", () => {
    const pairs = planVenueNearPairs([
      v({
        id: "c869050e",
        name: "Snowport at Boston Seaport",
        latitude: 42.3496,
        longitude: -71.0438,
      }),
      v({
        id: "ee7583f2",
        name: "Snowport at Seaport Common",
        latitude: 42.3508,
        longitude: -71.0455,
      }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      reason: "name_tokens",
      shared_tokens: ["seaport", "snowport"],
    });
    expect(new Set(pairs[0].venue_ids)).toEqual(new Set(["c869050e", "ee7583f2"]));
  });

  it("does not pair two schools that share only the town and 'school'", () => {
    expect(
      planVenueNearPairs([
        v({ id: "a", name: "Scarborough High School", city: "Scarborough", state: "ME" }),
        v({ id: "b", name: "Scarborough Middle School", city: "Scarborough", state: "ME" }),
      ])
    ).toEqual([]);
  });

  it("does not pair on a state word ('Rhode Island Convention Center' / 'Farm Fresh Rhode Island')", () => {
    expect(
      planVenueNearPairs([
        v({ id: "a", name: "Rhode Island Convention Center", city: "Providence", state: "RI" }),
        v({ id: "b", name: "Farm Fresh Rhode Island", city: "Providence", state: "RI" }),
      ])
    ).toEqual([]);
  });

  it("one shared token pairs only when geocoded within 300 m", () => {
    const near = [
      v({ id: "a", name: "Hatch Shell", latitude: 42.3577, longitude: -71.0739 }),
      v({ id: "b", name: "Hatch Esplanade Stage", latitude: 42.3585, longitude: -71.0745 }),
    ];
    expect(planVenueNearPairs(near)[0]?.reason).toBe("geo_and_name");
    const far = near.map((r, i) => (i === 1 ? { ...r, latitude: 42.4, longitude: -71.2 } : r));
    expect(planVenueNearPairs(far)).toEqual([]);
  });

  it("never pairs across cities", () => {
    expect(
      planVenueNearPairs([
        v({ id: "a", name: "Snowport at Boston Seaport" }),
        v({ id: "b", name: "Snowport at Seaport Common", city: "Cambridge" }),
      ])
    ).toEqual([]);
  });

  it("haversine is sane (Snowport rows ~190 m apart)", () => {
    const d = haversineMeters(42.3496, -71.0438, 42.3508, -71.0455);
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(250);
  });
});
