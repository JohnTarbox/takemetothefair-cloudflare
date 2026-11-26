/**
 * OPE-1653 — field history, part 2, app side: the unattended content writers
 * OPE-1651 left unlogged. One test per app-side group of the ticket's scope
 * (the MCP-side groups are in `mcp-server/__tests__/field-history-ope1653.test.ts`).
 *
 * Runs on the MCP harness's schema (it loads the entity_field_history migration
 * itself), so the table under test is the one prod runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb } from "../../../mcp-server/__tests__/setup-db";
import {
  entityFieldHistory,
  events,
  eventSeries,
  promoters,
  users,
  vendors,
  venues,
} from "@/lib/db/schema";

let db: ReturnType<typeof createTestDb>["db"];
const OWNER = "u-vendor-owner";

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: OWNER, role: "VENDOR" } })),
}));
vi.mock("@/lib/vendor-photo-auth", () => ({
  authorizeVendorGallery: vi.fn(async () => ({ ok: true })),
}));

import { DELETE as vendorLogoDelete } from "@/app/api/vendor-photos/logo/route";
import { fillVenueGoogleAmenities } from "@/lib/venues/google-amenity-fill";
import { attachEventToSeries } from "@takemetothefair/event-series";

const history = () => db.select().from(entityFieldHistory).all();

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(users).values({ id: OWNER, email: "owner@example.com", role: "VENDOR" }).run();
});
afterEach(() => vi.unstubAllGlobals());

describe("group 4 — image writes outside the pipeline: removing a vendor logo", () => {
  it("keeps the removed logo URL in a history row attributed to the vendor's user", async () => {
    db.insert(vendors)
      .values({
        id: "v-1",
        userId: OWNER,
        businessName: "Acme Soap",
        slug: unsafeSlug("acme-soap"),
        logoUrl: "https://cdn.meetmeatthefair.com/vendors/v-1/logo.png",
      })
      .run();

    const res = await vendorLogoDelete(
      new Request("https://meetmeatthefair.com/api/vendor-photos/logo", {
        method: "DELETE",
        body: JSON.stringify({ vendorId: "v-1" }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(200);
    const after = db.select().from(vendors).where(eq(vendors.id, "v-1")).all()[0];
    expect(after.logoUrl).toBeNull(); // landmark: the removal landed

    expect(history()).toMatchObject([
      {
        entityType: "vendor",
        entityId: "v-1",
        field: "logo_url",
        oldValue: "https://cdn.meetmeatthefair.com/vendors/v-1/logo.png",
        newValue: null,
        actor: OWNER,
        source: "api:DELETE /api/vendor-photos/logo",
      },
    ]);
  });
});

describe("group 5 — venue sweeps: the Google amenity fill", () => {
  it("records each amenity column it filled, actor system:<caller>", async () => {
    db.insert(venues)
      .values({
        id: "ven-1",
        name: "Fairgrounds",
        slug: unsafeSlug("fairgrounds"),
        address: "1 Main",
        zip: "04037",
        city: "Fryeburg",
        state: "ME",
        googlePlaceId: "pid-1",
      } as never)
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "pid-1", parkingOptions: { freeParkingLot: true } }))
      )
    );

    const r = await fillVenueGoogleAmenities(db as never, "ven-1", "k", { actor: "venue-sweep" });
    expect(r.status).toBe("filled"); // landmark

    const rows = history();
    expect(rows.map((x) => x.field).sort()).toEqual(["accessibility", "parking"]);
    for (const row of rows) {
      expect(row).toMatchObject({
        entityType: "venue",
        entityId: "ven-1",
        oldValue: null,
        actor: "system:venue-sweep",
        source: "lib:venues/google-amenity-fill",
      });
    }
  });
});

describe("group 6 — series attach: attachEventToSeries", () => {
  beforeEach(() => {
    db.insert(promoters)
      .values({ id: "p1", companyName: "P", slug: unsafeSlug("p") })
      .run();
    // The resolver skips an event with no venue, so the fixture carries one.
    db.insert(venues)
      .values({
        id: "ven-cg",
        name: "Common Ground",
        slug: unsafeSlug("common-ground"),
        address: "294 Crosby Brook Rd",
        zip: "04915",
        city: "Unity",
        state: "ME",
      } as never)
      .run();
    db.insert(events)
      .values({
        id: "e1",
        name: "Common Ground Fair",
        slug: unsafeSlug("common-ground-fair-2027"),
        promoterId: "p1",
        venueId: "ven-cg",
        status: "APPROVED",
        startDate: new Date("2027-09-24T12:00:00Z"),
        endDate: new Date("2027-09-26T12:00:00Z"),
      })
      .run();
  });

  it("records the series an unattached event joined (null → series id)", async () => {
    const res = await attachEventToSeries(db as never, "e1", {
      name: "Common Ground Fair",
      venueId: "ven-cg",
      promoterId: "p1",
    });
    expect(res.seriesId).toBeTruthy();
    const attached = db.select().from(events).where(eq(events.id, "e1")).all()[0];
    expect(attached.seriesId).toBe(res.seriesId); // landmark

    expect(history()).toMatchObject([
      {
        entityType: "event",
        entityId: "e1",
        field: "series_id",
        oldValue: null,
        newValue: res.seriesId,
        actor: "system:series-attach",
      },
    ]);
  });

  it("an already-attached event is left alone by the guard and gets no row", async () => {
    db.insert(eventSeries)
      .values({ id: "s-old", canonicalSlug: "s-old", name: "Old" } as never)
      .run();
    db.update(events).set({ seriesId: "s-old" }).where(eq(events.id, "e1")).run();

    await attachEventToSeries(db as never, "e1", {
      name: "Common Ground Fair",
      venueId: "ven-cg",
      promoterId: "p1",
    });
    const row = db.select().from(events).where(eq(events.id, "e1")).all()[0];
    expect(row.seriesId).toBe("s-old"); // landmark: the guard held
    expect(history()).toEqual([]);
  });
});
