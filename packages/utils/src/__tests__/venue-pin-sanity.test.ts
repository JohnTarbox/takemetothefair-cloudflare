/**
 * OPE-1079 — the pure town-median pin check shared by the main app and the MCP
 * Worker. Coordinates are real prod pins.
 */
import { describe, expect, it } from "vitest";
import { checkPinAgainstTown, PIN_TOWN_OUTLIER_KM, pinTownWarning } from "../venue-pin-sanity";

const PHILLIPS_PEERS = [
  { lat: 44.8230779, lng: -70.3422473 }, // American Legion Post 64
  { lat: 44.8227386, lng: -70.3423184 }, // Phillips Area Community Center
];

describe("checkPinAgainstTown (OPE-1079)", () => {
  it("returns null with fewer than 2 usable peers — no reference, no verdict", () => {
    expect(checkPinAgainstTown({ lat: 44.994, lng: -70.0557 }, [])).toBeNull();
    expect(
      checkPinAgainstTown({ lat: 44.994, lng: -70.0557 }, [
        { lat: 44.9, lng: -70.0 },
        { lat: null, lng: -70.0 },
      ])
    ).toBeNull();
  });

  it("measures against the MEDIAN, so one bad peer cannot drag the reference", () => {
    const peers = [
      { lat: 43.8577, lng: -70.103 },
      { lat: 43.856, lng: -70.1045 },
      { lat: 43.8571, lng: -70.0998 },
      { lat: 46.9, lng: -68.0 }, // a wildly wrong pin already in town
    ];
    const ok = checkPinAgainstTown({ lat: 43.857, lng: -70.1 }, peers)!;
    expect(ok.far).toBe(false);
    expect(ok.distanceKm).toBeLessThan(1);
  });

  it("does NOT flag Phillips' 7.1 km 'Downtown Phillips' pin — the honest limit at 10 km", () => {
    const r = checkPinAgainstTown({ lat: 44.8470536, lng: -70.4245011 }, PHILLIPS_PEERS)!;
    expect(r.distanceKm).toBeGreaterThan(6.5);
    expect(r.distanceKm).toBeLessThan(7.5);
    expect(r.far).toBe(false);
  });

  it("flags a pin past the threshold, and honours a custom threshold", () => {
    const far = checkPinAgainstTown({ lat: 44.95, lng: -70.34 }, PHILLIPS_PEERS)!;
    expect(far.far).toBe(true);
    expect(far.thresholdKm).toBe(PIN_TOWN_OUTLIER_KM);
    const under = checkPinAgainstTown(
      { lat: 44.95, lng: -70.34 },
      PHILLIPS_PEERS,
      far.distanceKm + 0.01
    )!;
    expect(under.far).toBe(false); // just inside a custom threshold is not "far"
  });

  it("the warning names the distance, the town and the fix", () => {
    const r = checkPinAgainstTown({ lat: 44.95, lng: -70.34 }, PHILLIPS_PEERS)!;
    const w = pinTownWarning(r, { city: "Phillips", state: "ME" });
    expect(w).toContain(`${r.distanceKm} km`);
    expect(w).toContain("Phillips, ME");
    expect(w).toContain("update_venue");
  });
});
