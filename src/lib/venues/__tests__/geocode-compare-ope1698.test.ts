/**
 * OPE-1698 — `compare_only` re-geocodes an already-pinned venue and reports the
 * distance, and writes NOTHING.
 *
 * The fake db's `update` / `insert` throw, so "wrote nothing" is enforced by the
 * harness rather than asserted on a spy someone might forget to check. The
 * positive landmark beside it: the same harness DOES see the write on a normal
 * `force` call, so a fake that could never observe a write is ruled out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/google-maps", () => ({
  geocodeAddressDetailed: vi.fn(),
  lookupPlace: vi.fn(),
}));
vi.mock("@/lib/audit/record-mutation", () => ({ recordMutation: vi.fn() }));
vi.mock("@/lib/venues/pin-sanity", () => ({ flagVenuePinIfFarFromTown: vi.fn(async () => null) }));
vi.mock("@/lib/venues/google-amenity-fill", () => ({ fillVenueGoogleAmenities: vi.fn() }));

import { geocodeAddressDetailed } from "@/lib/google-maps";
import { geocodeVenueRow } from "@/lib/venues/geocode-one";
import { compareToStored, distanceBucket } from "@/lib/venues/geocode-decision";

const SPHS = {
  id: "91da3283-test",
  name: "South Portland High School",
  address: "637 Highland Ave",
  city: "South Portland",
  state: "ME",
  zip: "04106",
  // The hand-rounded pin from the ticket.
  latitude: 43.6263,
  longitude: -70.3007,
};

function detail(over: Record<string, unknown> = {}) {
  return {
    lat: 43.6305,
    lng: -70.2678,
    placeId: "ChIJ-sphs",
    zip: "04106",
    formattedAddress: "637 Highland Ave, South Portland, ME 04106, USA",
    candidateCount: 1,
    partialMatch: false,
    locationType: "ROOFTOP",
    ...over,
  };
}

function fakeDb(owner: unknown[] = []) {
  const writes: string[] = [];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => owner,
  };
  return {
    writes,
    db: {
      select: () => chain,
      update: () => {
        writes.push("update");
        return { set: () => ({ where: async () => undefined }) };
      },
      insert: () => {
        writes.push("insert");
        return { values: async () => undefined };
      },
    },
  };
}

beforeEach(() => vi.mocked(geocodeAddressDetailed).mockReset());

describe("OPE-1698 compare_only", () => {
  it("re-asks Google for an already-pinned venue and reports the distance, writing nothing", async () => {
    vi.mocked(geocodeAddressDetailed).mockResolvedValue(detail() as never);
    const { db, writes } = fakeDb();
    const out = await geocodeVenueRow(db, SPHS, "k", false, { compareOnly: true });
    expect(geocodeAddressDetailed).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("ok");
    expect(out.compare?.confident).toBe(true);
    expect(out.compare?.bucket).toBe(">1km");
    expect(out.compare?.distance_m).toBeGreaterThan(2000);
    expect(out.compare?.stored).toEqual({ lat: 43.6263, lng: -70.3007 });
    expect(writes).toEqual([]);
  });

  it("a low-confidence fresh pin is reported (with distance) but not confident", async () => {
    vi.mocked(geocodeAddressDetailed).mockResolvedValue(detail({ candidateCount: 3 }) as never);
    const { db, writes } = fakeDb();
    const out = await geocodeVenueRow(db, SPHS, "k", false, { compareOnly: true });
    expect(out.status).toBe("low-confidence");
    expect(out.compare?.fresh).not.toBeNull();
    expect(out.compare?.confident).toBe(false);
    expect(writes).toEqual([]);
  });

  it("a Place another venue owns comes back duplicate-with, still with the comparison", async () => {
    vi.mocked(geocodeAddressDetailed).mockResolvedValue(detail() as never);
    const { db, writes } = fakeDb([{ id: "other", name: "Other", slug: "other" }]);
    const out = await geocodeVenueRow(db, SPHS, "k", false, { compareOnly: true });
    expect(out.status).toBe("duplicate-with");
    expect(out.compare?.confident).toBe(false);
    expect(writes).toEqual([]);
  });

  it("landmark: the same harness DOES observe the write on a normal force call", async () => {
    vi.mocked(geocodeAddressDetailed).mockResolvedValue(detail() as never);
    const { db, writes } = fakeDb();
    const out = await geocodeVenueRow(db, SPHS, "k", true);
    expect(out.status).toBe("ok");
    expect(writes).toContain("update");
    expect(out.compare).toBeUndefined();
  });

  it("without compare_only or force an already-pinned venue never reaches Google", async () => {
    const { db } = fakeDb();
    const out = await geocodeVenueRow(db, SPHS, "k", false);
    expect(out.status).toBe("already-geocoded");
    expect(geocodeAddressDetailed).not.toHaveBeenCalled();
  });
});

describe("OPE-1698 distance helpers", () => {
  it("buckets on the ticket's boundaries", () => {
    expect(distanceBucket(0)).toBe("<100m");
    expect(distanceBucket(99)).toBe("<100m");
    expect(distanceBucket(100)).toBe("100m-1km");
    expect(distanceBucket(1000)).toBe("100m-1km");
    expect(distanceBucket(1001)).toBe(">1km");
  });

  it("a missing fresh pin has no distance and is never confident", () => {
    const c = compareToStored(SPHS, { status: "no-match" } as never, null);
    expect(c.distance_m).toBeNull();
    expect(c.bucket).toBeNull();
    expect(c.confident).toBe(false);
  });

  it("an ok verdict without a place id is not confident", () => {
    const c = compareToStored(SPHS, { status: "ok" } as never, {
      lat: 43.6263,
      lng: -70.3007,
      placeId: null,
    });
    expect(c.distance_m).toBe(0);
    expect(c.confident).toBe(false);
  });
});

describe("OPE-1698 route: a compare pass stops before the amenity fill (which writes and bills)", () => {
  it("the compare_only `continue` precedes the fillVenueGoogleAmenities CALL", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/admin/venues/geocode-venues/route.ts", "utf8");
    // Anchor on call syntax, not the bare symbol — the import line names it too.
    const call = src.indexOf("await fillVenueGoogleAmenities(");
    const skip = src.search(/if \(compareOnly\) \{\s*await new Promise[^\n]*\n\s*continue;/);
    expect(call).toBeGreaterThan(0);
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(call);
    // And the route refuses the two contradictory pairings.
    expect(src).toMatch(/compareOnly && \(body\.missing_only \|\| force\)/);
  });
});
