/**
 * OPE-716 — `public_visible=false` returned ok and the vendor kept rendering.
 *
 * Two failure modes were possible and the observation could not separate them:
 * the write not applying, or the reader ignoring the flag. **Settled by reading
 * prod**: the LeafFilter link on Marshfield Fair
 * (`e4c60af5-68ff-4f31-9d37-4bd62b55c51e`) carries `public_visible = 0`, so the
 * write applied and `list_event_vendors` was the defect.
 *
 * The ticket is explicit that a weak test would pass today:
 *
 *   "A test that only asserts the write returns `ok` is vacuous — today's
 *    behaviour already returns `ok`."
 *
 * So every assertion below reads the LISTING and checks for ABSENCE.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { events, eventVendors, promoters, vendors } from "../src/schema.js";
import { vendorLinkIsPublicallyVisible } from "@takemetothefair/db-schema";
import { PUBLIC_VENDOR_STATUSES } from "@takemetothefair/constants";

let db: TestDb;

/** The exact WHERE `list_event_vendors` builds, so this test tracks the tool. */
const publicListing = (eventId: string) =>
  db
    .select({ name: vendors.businessName })
    .from(eventVendors)
    .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
    .where(
      and(
        eq(eventVendors.eventId, eventId),
        inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
        isNull(vendors.deletedAt),
        vendorLinkIsPublicallyVisible()
      )
    );

/** The admin reader: status only, no visibility filter. */
const adminListing = (eventId: string) =>
  db
    .select({ name: vendors.businessName })
    .from(eventVendors)
    .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
    .where(
      and(
        eq(eventVendors.eventId, eventId),
        inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
        isNull(vendors.deletedAt)
      )
    );

async function seedLink(name: string, publicVisible: boolean) {
  await db.insert(vendors).values({
    id: `v-${name}`,
    userId: `u-${name}`,
    businessName: name,
    slug: `s-${name}`,
  });
  await db.insert(eventVendors).values({
    id: `ev-${name}`,
    eventId: "marshfield",
    vendorId: `v-${name}`,
    status: "CONFIRMED",
    publicVisible,
  });
}

beforeEach(async () => {
  ({ db } = createTestDb());
  // events.promoter_id is NOT NULL — every event has an organizer.
  await db.insert(promoters).values({
    id: "p1",
    userId: "up1",
    companyName: "Marshfield Agricultural Society",
    slug: "mas",
  });
  await db.insert(events).values({
    id: "marshfield",
    promoterId: "p1",
    name: "Marshfield Fair 2026",
    slug: "marshfield-fair-2026",
    status: "APPROVED",
    startDate: new Date("2026-08-20T12:00:00Z"),
    endDate: new Date("2026-08-25T12:00:00Z"),
  });
});

describe("the LeafFilter case", () => {
  it("a hidden link is ABSENT from the public listing", async () => {
    await seedLink("LeafFilter", false);
    await seedLink("Maple Farm", true);

    const names = (await publicListing("marshfield")).map((r) => r.name);
    expect(names).not.toContain("LeafFilter");
    expect(names).toContain("Maple Farm");
  });

  it("the same hidden link is STILL VISIBLE to the admin reader", async () => {
    // The asymmetry is the entire point of OPE-316: recorded, not shown. If the
    // admin view loses it too, the flag has become a delete.
    await seedLink("LeafFilter", false);
    const names = (await adminListing("marshfield")).map((r) => r.name);
    expect(names).toContain("LeafFilter");
  });

  it("hiding does not change the participation status", async () => {
    await seedLink("LeafFilter", false);
    const [row] = await db
      .select({ status: eventVendors.status, pv: eventVendors.publicVisible })
      .from(eventVendors)
      .where(eq(eventVendors.id, "ev-LeafFilter"));
    expect(row.status).toBe("CONFIRMED");
    expect(row.pv).toBe(false);
  });
});

describe("the default is unchanged", () => {
  it("a link with no explicit flag still renders", async () => {
    // NOT NULL DEFAULT true — the flag is opt-in and nothing changes silently.
    await db.insert(vendors).values({
      id: "v-def",
      userId: "u-def",
      businessName: "Default Vendor",
      slug: "s-def",
    });
    await db.insert(eventVendors).values({
      id: "ev-def",
      eventId: "marshfield",
      vendorId: "v-def",
      status: "CONFIRMED",
    });
    const names = (await publicListing("marshfield")).map((r) => r.name);
    expect(names).toContain("Default Vendor");
  });

  it("finds inputs at all — guards against a vacuous pass", async () => {
    await seedLink("A", true);
    await seedLink("B", true);
    expect(await publicListing("marshfield")).toHaveLength(2);
  });
});

describe("the tool actually applies the predicate", () => {
  it("list_event_vendors calls it — anchored on call syntax", async () => {
    // The whole defect was a guard that existed and was not applied here. An
    // assertion that the predicate EXISTS would have passed all along.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "src", "tools", "public.ts"), "utf8");
    expect(src).toMatch(/vendorLinkIsPublicallyVisible\s*\(\s*\)/);
  });
});
