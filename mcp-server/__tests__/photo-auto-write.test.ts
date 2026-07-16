/**
 * OPE-204 Milestone B — booth-photo auto-write. Exercised against the real
 * in-memory SQLite (same harness as create-or-link-vendor.test) so the writes
 * through the shared tail are genuine: a vendor row, an event_vendors link, and
 * the idempotency marker.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { adminActions, eventVendors, events, promoters, vendors } from "../src/schema.js";
import { autoWriteBooths, BOOTH_AUTOWRITTEN_ACTION } from "../src/photo/auto-write.js";
import type { Db } from "../src/db.js";
import type { BoothIdentification } from "../src/photo/vision.js";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
  db.insert(events)
    .values({
      id: "event-1",
      name: "Cumberland Fair",
      slug: "cumberland-fair",
      promoterId: "promoter-1",
      status: "APPROVED",
    })
    .run();
});

const booth = (over: Partial<BoothIdentification> = {}): BoothIdentification => ({
  kind: "booth",
  businessName: "Maple Hollow Farm",
  website: null,
  products: ["syrup"],
  confidence: 0.9,
  rationale: "banner on the stall",
  ...over,
});

const item = (photoKey: string, id = booth()) => ({ photoKey, photoName: "a.jpg", id });

// No MAIN_APP_URL/INTERNAL_API_KEY → hero-if-blank is a no-op (heroSet false),
// which keeps these tests off the network. Hero has its own path in §2's tests.
const ENV = {};

describe("autoWriteBooths", () => {
  it("creates a vendor, links it CONFIRMED, and writes the idempotency marker", async () => {
    const out = await autoWriteBooths(ENV, db as unknown as Db, "ie1", "event-1", [item("k1")]);

    expect(out).toHaveLength(1);
    expect(out[0].wasCreated).toBe(true);
    expect(out[0].vendorId).toBeTruthy();

    // Real vendor row + event link exist.
    const v = db.select().from(vendors).where(eq(vendors.businessName, "Maple Hollow Farm")).all();
    expect(v).toHaveLength(1);
    const links = db
      .select()
      .from(eventVendors)
      .where(and(eq(eventVendors.eventId, "event-1"), eq(eventVendors.vendorId, v[0].id)))
      .all();
    expect(links).toHaveLength(1);
    expect(links[0].status).toBe("CONFIRMED");
    expect(links[0].participationType).toBe("EXHIBITOR");

    // Marker written, keyed to the email + photo.
    const markers = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, BOOTH_AUTOWRITTEN_ACTION))
      .all();
    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0].payloadJson!).photo_key).toBe("k1");
  });

  it("is idempotent — a re-run with the same photo_key writes nothing new", async () => {
    await autoWriteBooths(ENV, db as unknown as Db, "ie1", "event-1", [item("k1")]);
    const out2 = await autoWriteBooths(ENV, db as unknown as Db, "ie1", "event-1", [item("k1")]);

    // Second run skipped the already-written photo.
    expect(out2).toHaveLength(0);
    // No duplicate vendor, link, or marker.
    expect(db.select().from(vendors).all()).toHaveLength(1);
    expect(db.select().from(eventVendors).all()).toHaveLength(1);
    expect(
      db.select().from(adminActions).where(eq(adminActions.action, BOOTH_AUTOWRITTEN_ACTION)).all()
    ).toHaveLength(1);
  });

  it("dedups the vendor across two different photos of the same booth", async () => {
    // Same business, two photos (k1, k2) — one vendor, two markers, one link.
    const out = await autoWriteBooths(ENV, db as unknown as Db, "ie1", "event-1", [
      item("k1"),
      item("k2"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].wasCreated).toBe(true);
    expect(out[1].wasCreated).toBe(false); // second links the existing vendor
    expect(db.select().from(vendors).all()).toHaveLength(1);
    expect(db.select().from(eventVendors).all()).toHaveLength(1);
  });

  it("writes each booth sequentially with distinct vendors", async () => {
    const out = await autoWriteBooths(ENV, db as unknown as Db, "ie1", "event-1", [
      item("k1", booth({ businessName: "Alpha Crafts" })),
      item("k2", booth({ businessName: "Beta Bakery" })),
    ]);
    expect(out.map((o) => o.businessName)).toEqual(["Alpha Crafts", "Beta Bakery"]);
    expect(db.select().from(vendors).all()).toHaveLength(2);
  });

  it("surfaces a write failure instead of throwing", async () => {
    const out = await autoWriteBooths(ENV, db as unknown as Db, "ie1", "nonexistent-event", [
      item("k1"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].error).toContain("Event not found");
    expect(out[0].vendorId).toBeNull();
    // No marker for a failed write — so a retry can try again.
    expect(
      db.select().from(adminActions).where(eq(adminActions.action, BOOTH_AUTOWRITTEN_ACTION)).all()
    ).toHaveLength(0);
  });

  it("no-ops on an empty batch", async () => {
    expect(await autoWriteBooths(ENV, db as unknown as Db, "ie1", "event-1", [])).toEqual([]);
  });
});
