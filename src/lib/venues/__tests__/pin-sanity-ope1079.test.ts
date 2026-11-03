/**
 * OPE-1079 — write-time pin sanity: a geocoder pin implausibly far from the
 * other venues in its own city+state is FLAGGED (admin_actions + a warning on
 * the outcome), never blocked. Real SQLite, schema-derived DDL, the shipped
 * `geocodeVenueRow` with only the Google call mocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { venues, adminActions } from "@/lib/db/schema";

const googleHit = vi.hoisted(() => ({ lat: 0, lng: 0 }));
vi.mock("@/lib/google-maps", () => ({
  geocodeAddressDetailed: async () => ({
    lat: googleHit.lat,
    lng: googleHit.lng,
    placeId: "ChIJtest",
    zip: null,
    formattedAddress: "1 Test St",
    candidateCount: 1,
    partialMatch: false,
    locationType: "ROOFTOP",
  }),
  lookupPlace: async () => null,
}));

import { geocodeVenueRow } from "@/lib/venues/geocode-one";
import { flagVenuePinIfFarFromTown } from "@/lib/venues/pin-sanity";
import { VENUE_PIN_FAR_FROM_TOWN_ACTION } from "@takemetothefair/utils";

let db: ReturnType<typeof drizzle<typeof schema>>;

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType().toUpperCase();
    const type = t.includes("INT") ? "INTEGER" : t.includes("REAL") ? "REAL" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

// Three real Freeport, ME pins from prod (L.L.Bean, Chamber, Hilton Garden Inn).
const FREEPORT = [
  { id: "f1", lat: 43.8577105, lng: -70.1029706 },
  { id: "f2", lat: 43.8559512, lng: -70.1045088 },
  { id: "f3", lat: 43.8571379, lng: -70.0997861 },
];

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = drizzle(raw, { schema });
  db.insert(venues)
    .values(
      FREEPORT.map((f) => ({
        id: f.id,
        name: `Venue ${f.id}`,
        slug: f.id as never,
        address: "Main St",
        city: "Freeport",
        state: "ME",
        zip: "04032",
        latitude: f.lat,
        longitude: f.lng,
      })) as never
    )
    .run();
  db.insert(venues)
    .values({
      id: "new",
      name: "New Freeport Venue",
      slug: "new" as never,
      address: "5 Park St",
      // Different case/whitespace on purpose: the town key is normalised.
      city: " freeport ",
      state: "me",
      zip: "04032",
    } as never)
    .run();
});

const newVenue = () => db.select().from(venues).where(eq(venues.id, "new")).all()[0];
const flags = () =>
  db
    .select()
    .from(adminActions)
    .where(eq(adminActions.action, VENUE_PIN_FAR_FROM_TOWN_ACTION))
    .all();

describe("geocodeVenueRow — pin sanity (OPE-1079)", () => {
  it("stores a far pin (never blocks) but flags it with a warning and an admin_actions row", async () => {
    // Brunswick Landing — ~15 km from Freeport's median.
    googleHit.lat = 43.8937598;
    googleHit.lng = -69.9270216;
    const outcome = await geocodeVenueRow(db, newVenue() as never, "key", false);

    expect(outcome.status).toBe("ok");
    expect(newVenue().latitude).toBeCloseTo(43.8937598, 6); // written anyway
    expect(outcome.pin_warning).toMatch(/km from the median of 3 other venues in freeport, me/i);

    const rows = flags();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: "venue", targetId: "new" });
    const p = JSON.parse(rows[0].payloadJson as string);
    expect(p.source).toBe("venues_geocode:ok");
    expect(p.peers).toBe(3);
    expect(p.distance_km).toBeGreaterThan(10);
  });

  it("an in-town pin writes no flag and no warning", async () => {
    googleHit.lat = 43.8571;
    googleHit.lng = -70.0998;
    const outcome = await geocodeVenueRow(db, newVenue() as never, "key", false);
    expect(outcome.status).toBe("ok");
    expect(outcome.pin_warning).toBeUndefined();
    expect(flags()).toHaveLength(0);
  });
});

describe("flagVenuePinIfFarFromTown — the skip rule (OPE-1079)", () => {
  it("skips when fewer than 2 OTHER pinned venues share the town (New Portland had 0)", async () => {
    const res = await flagVenuePinIfFarFromTown(db, {
      venueId: "f1",
      city: "New Portland",
      state: "ME",
      lat: 44.994,
      lng: -70.0557,
      source: "test",
    });
    expect(res).toBeNull();
    expect(flags()).toHaveLength(0);
  });

  it("excludes the venue itself from its own reference", async () => {
    // Move f1 far away: its peers are f2+f3 (2), so the check still runs.
    const res = await flagVenuePinIfFarFromTown(db, {
      venueId: "f1",
      city: "Freeport",
      state: "ME",
      lat: 44.5,
      lng: -70.1,
      source: "test",
    });
    expect(res?.check.peers).toBe(2);
    expect(res?.check.far).toBe(true);
  });
});
