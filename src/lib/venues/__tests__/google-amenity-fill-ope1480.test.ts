/**
 * OPE-1480 — Google accessibility + parking onto venues: never blank existing
 * data, record "Google has none" as "{}", and run from the creation path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "../../../../mcp-server/__tests__/setup-db";
import { venues } from "@/lib/db/schema";
import {
  amenityFillUpdates,
  fillVenueGoogleAmenities,
  needsAmenityFill,
} from "@/lib/venues/google-amenity-fill";
import { fetchPlaceAccessParking } from "@/lib/google-maps";

const ACCESS = JSON.stringify({ wheelchairAccessibleEntrance: true });
const PARK = JSON.stringify({ freeParkingLot: true });

describe("amenityFillUpdates — the write rule", () => {
  it("fills a never-fetched column, including with Google's 'none' ({})", () => {
    expect(
      amenityFillUpdates(
        { accessibility: null, parking: "" },
        { accessibility: ACCESS, parking: "{}" }
      )
    ).toEqual({ accessibility: ACCESS, parking: "{}" });
  });

  it("NEVER replaces existing Google data with an empty answer (acceptance: 0 non-empty → empty)", () => {
    expect(
      amenityFillUpdates(
        { accessibility: ACCESS, parking: PARK },
        { accessibility: "{}", parking: "{}" }
      )
    ).toEqual({});
  });

  it("upgrades a stored '{}' when Google later has data, and leaves equal data alone", () => {
    expect(
      amenityFillUpdates(
        { accessibility: "{}", parking: PARK },
        { accessibility: ACCESS, parking: PARK }
      )
    ).toEqual({ accessibility: ACCESS });
  });

  it("does not overwrite unparseable stored text", () => {
    expect(
      amenityFillUpdates(
        { accessibility: "legacy text", parking: null },
        { accessibility: ACCESS, parking: PARK }
      )
    ).toEqual({ parking: PARK });
  });

  it("needsAmenityFill is true only while a column is unfetched", () => {
    expect(needsAmenityFill({ accessibility: null, parking: PARK })).toBe(true);
    expect(needsAmenityFill({ accessibility: "{}", parking: "{}" })).toBe(false);
  });
});

describe("fetchPlaceAccessParking", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for ONLY the two fields, and maps absent options to {}", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "pid",
            accessibilityOptions: { wheelchairAccessibleEntrance: true },
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchPlaceAccessParking("pid", "k");
    expect(r).toEqual({ accessibility: ACCESS, parking: "{}" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe(
      "id,accessibilityOptions,parkingOptions"
    );
  });

  it("a failed call is null (nothing may be written from it)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x", { status: 403 }))
    );
    expect(await fetchPlaceAccessParking("pid", "k")).toBeNull();
  });
});

describe("fillVenueGoogleAmenities (real schema)", () => {
  let db: TestDb;
  beforeEach(() => {
    ({ db } = createTestDb());
  });
  afterEach(() => vi.unstubAllGlobals());

  function venue(id: string, extra: Record<string, unknown>) {
    db.insert(venues)
      .values({
        id,
        name: `V ${id}`,
        slug: unsafeSlug(`v-${id}`),
        address: "1 Main",
        zip: "",
        city: "Augusta",
        state: "ME",
        ...extra,
      } as never)
      .run();
  }
  const read = (id: string) =>
    db
      .select({ a: venues.accessibility, p: venues.parking })
      .from(venues)
      .where(eq(venues.id, id))
      .get();

  it("fills a new venue that has a place id, and records 'none' as {}", async () => {
    venue("v1", { googlePlaceId: "pid-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "pid-1", parkingOptions: { freeParkingLot: true } }))
      )
    );
    const r = await fillVenueGoogleAmenities(db, "v1", "k", { actor: "test" });
    expect(r).toEqual({ status: "filled", columns: ["accessibility", "parking"] });
    expect(read("v1")).toEqual({ a: "{}", p: PARK });
  });

  it("makes no Google call for a venue without a place id, or one already answered", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    venue("v2", {});
    venue("v3", { googlePlaceId: "pid-3", accessibility: ACCESS, parking: "{}" });
    expect((await fillVenueGoogleAmenities(db, "v2", "k", { actor: "t" })).status).toBe(
      "no-place-id"
    );
    expect((await fillVenueGoogleAmenities(db, "v3", "k", { actor: "t" })).status).toBe(
      "not-needed"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refetch of '{}' never blanks the column that has data", async () => {
    venue("v4", { googlePlaceId: "pid-4", accessibility: ACCESS, parking: "{}" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "pid-4" })))
    );
    const r = await fillVenueGoogleAmenities(db, "v4", "k", { actor: "t", refetchEmpty: true });
    expect(r.status).toBe("unchanged");
    expect(read("v4")).toEqual({ a: ACCESS, p: "{}" });
  });
});

describe("wired into the paths that create the gap (OPE-408 lesson)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("geocodeNewVenue — every venue-creation path — fills amenities", () => {
    const s = src("src/lib/venues/geocode-one.ts");
    const body = s.slice(s.indexOf("export async function geocodeNewVenue"));
    expect(body).toMatch(/await fillVenueGoogleAmenities\(db, venueId, apiKey/);
  });
  it("the geocode sweep fills amenities for a venue it just matched", () => {
    expect(src("src/app/api/admin/venues/geocode-venues/route.ts")).toMatch(
      /await fillVenueGoogleAmenities\(db, v\.id, apiKey/
    );
  });
});
