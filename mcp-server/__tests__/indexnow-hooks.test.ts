/**
 * Regression tests for IndexNow lifecycle hooks in the MCP server tools.
 *
 * Why this exists: the MCP server writes directly to D1, bypassing the main
 * app's API routes. The IndexNow hooks have to be wired in BOTH places, and
 * a previous round-2 SEO change missed the MCP entirely until production
 * caught it. This test treats every hooked write as a contract: tool X
 * with input Y MUST trigger an IndexNow ping with source label Z.
 *
 * Each test invokes a tool handler against an in-memory SQLite, mocks the
 * fetch that `triggerIndexNow` uses to call the main app, and asserts the
 * captured `source` label. Negative cases verify that non-material updates
 * stay quiet — a noisy ping is also a regression.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import {
  users,
  venues,
  vendors,
  promoters,
  events,
  vendorSlugHistory,
  adminActions,
} from "../src/schema.js";
import { eq } from "drizzle-orm";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const VENDOR_AUTH = { userId: "u-vendor", role: "VENDOR" as const, vendorId: "v-1" };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let adminServer: CapturingMcpServer;
let vendorServer: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  adminServer = new CapturingMcpServer();
  vendorServer = new CapturingMcpServer();
  // Cast to McpServer — only `.tool()` is exercised by registration
  registerAdminTools(adminServer as never, db, ADMIN_AUTH, ENV as never);
  registerVendorTools(vendorServer as never, db, VENDOR_AUTH, ENV);
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

// Helpers -------------------------------------------------------------------

function seedVenue(overrides: Partial<typeof venues.$inferInsert> = {}) {
  const id = overrides.id ?? "venue-1";
  db.insert(venues)
    .values({
      id,
      name: "Test Venue",
      slug: overrides.slug ?? "test-venue",
      address: "1 Main St",
      city: "Portland",
      state: "ME",
      zip: "04101",
      status: "ACTIVE",
      ...overrides,
    })
    .run();
  return id;
}

function seedPromoter(overrides: Partial<typeof promoters.$inferInsert> = {}) {
  const id = overrides.id ?? "promoter-1";
  db.insert(promoters)
    .values({
      id,
      companyName: "Test Promoter",
      slug: overrides.slug ?? "test-promoter",
      ...overrides,
    })
    .run();
  return id;
}

function seedEvent(overrides: Partial<typeof events.$inferInsert> = {}) {
  const id = overrides.id ?? "event-1";
  if (!overrides.promoterId) seedPromoter();
  db.insert(events)
    .values({
      id,
      name: overrides.name ?? "Test Event",
      slug: overrides.slug ?? "test-event",
      promoterId: overrides.promoterId ?? "promoter-1",
      status: "DRAFT",
      ...overrides,
    })
    .run();
  return id;
}

function seedVendor(overrides: Partial<typeof vendors.$inferInsert> = {}) {
  const userId = overrides.userId ?? "u-1";
  db.insert(users)
    .values({ id: userId, email: `${userId}@test`, role: "VENDOR" })
    .run();
  const id = overrides.id ?? "vendor-1";
  db.insert(vendors)
    .values({
      id,
      userId,
      businessName: overrides.businessName ?? "Test Vendor",
      slug: overrides.slug ?? "test-vendor",
      ...overrides,
    })
    .run();
  return id;
}

// update_event_status -------------------------------------------------------

describe("update_event_status", () => {
  it("DRAFT → APPROVED fires event-create", async () => {
    const id = seedEvent({ status: "DRAFT" });
    await adminServer.invoke("update_event_status", { event_id: id, status: "APPROVED" });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].source).toBe("event-create");
    expect(mock.calls[0].urls[0]).toContain("/events/test-event");
  });

  it("DRAFT → TENTATIVE fires event-create (TENTATIVE is publicly visible)", async () => {
    const id = seedEvent({ status: "DRAFT" });
    await adminServer.invoke("update_event_status", { event_id: id, status: "TENTATIVE" });
    expect(mock.calls.map((c) => c.source)).toEqual(["event-create"]);
  });

  it("TENTATIVE → APPROVED fires event-approve (the round-2 bug)", async () => {
    const id = seedEvent({ status: "TENTATIVE", slug: "fiddlehead-festival" });
    await adminServer.invoke("update_event_status", { event_id: id, status: "APPROVED" });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].source).toBe("event-approve");
    expect(mock.calls[0].urls[0]).toContain("/events/fiddlehead-festival");
  });

  it("APPROVED → CANCELLED does NOT ping (leaving the public set)", async () => {
    const id = seedEvent({ status: "APPROVED" });
    await adminServer.invoke("update_event_status", { event_id: id, status: "CANCELLED" });
    expect(mock.calls).toHaveLength(0);
  });
});

// update_event (material change) --------------------------------------------

describe("update_event material-change", () => {
  it("editing description on APPROVED event fires event-update", async () => {
    const id = seedEvent({ status: "APPROVED", description: "old" });
    await adminServer.invoke("update_event", { event_id: id, description: "new and better" });
    expect(mock.calls.map((c) => c.source)).toEqual(["event-update"]);
  });

  it("editing only featured (non-material) does NOT ping", async () => {
    const id = seedEvent({ status: "APPROVED" });
    await adminServer.invoke("update_event", { event_id: id, featured: true });
    expect(mock.calls).toHaveLength(0);
  });

  it("editing description on DRAFT event does NOT ping (event isn't public yet)", async () => {
    const id = seedEvent({ status: "DRAFT" });
    await adminServer.invoke("update_event", { event_id: id, description: "anything" });
    expect(mock.calls).toHaveLength(0);
  });
});

// create_venue --------------------------------------------------------------

describe("create_venue", () => {
  it("fires venue-create on insert (venues default ACTIVE here)", async () => {
    const result = (await adminServer.invoke("create_venue", {
      name: "Civic Center",
      address: "100 Free St",
      city: "Portland",
      state: "ME",
      zip: "04101",
    })) as { content: Array<{ text: string }> };
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].source).toBe("venue-create");
    const payload = JSON.parse(result.content[0].text) as { slug: string };
    expect(mock.calls[0].urls[0]).toContain(`/venues/${payload.slug}`);
  });
});

// update_venue --------------------------------------------------------------

describe("update_venue", () => {
  it("INACTIVE → ACTIVE fires venue-activate", async () => {
    const id = seedVenue({ status: "INACTIVE" });
    await adminServer.invoke("update_venue", { venue_id: id, status: "ACTIVE" });
    expect(mock.calls.map((c) => c.source)).toEqual(["venue-activate"]);
  });

  it("editing address on ACTIVE venue fires venue-update", async () => {
    const id = seedVenue({ status: "ACTIVE" });
    await adminServer.invoke("update_venue", { venue_id: id, address: "200 New Rd" });
    expect(mock.calls.map((c) => c.source)).toEqual(["venue-update"]);
  });

  it("editing capacity (non-material) does NOT ping", async () => {
    const id = seedVenue({ status: "ACTIVE" });
    await adminServer.invoke("update_venue", { venue_id: id, capacity: 5000 });
    expect(mock.calls).toHaveLength(0);
  });
});

// create_vendor / update_vendor --------------------------------------------

describe("create_vendor", () => {
  it("fires vendor-create on insert", async () => {
    await adminServer.invoke("create_vendor", {
      business_name: "Artisan Hill Treats",
      type: "Food & Beverage",
      products: ["marshmallows"],
      location: "Dublin, NH",
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["vendor-create"]);
  });
});

describe("update_vendor", () => {
  it("editing vendor_type fires vendor-update", async () => {
    const id = seedVendor();
    await adminServer.invoke("update_vendor", { vendor_id: id, vendor_type: "Crafts" });
    expect(mock.calls.map((c) => c.source)).toEqual(["vendor-update"]);
  });

  it("editing only verified (non-material) does NOT ping", async () => {
    const id = seedVendor();
    await adminServer.invoke("update_vendor", { vendor_id: id, verified: true });
    expect(mock.calls).toHaveLength(0);
  });

  it("editing only commercial (non-material) does NOT ping", async () => {
    const id = seedVendor();
    await adminServer.invoke("update_vendor", { vendor_id: id, commercial: true });
    expect(mock.calls).toHaveLength(0);
  });

  // Round-3 additions: gallery_images, enhanced_profile, and slug are
  // now part of the material list.
  it("editing gallery_images fires vendor-update", async () => {
    const id = seedVendor();
    await adminServer.invoke("update_vendor", {
      vendor_id: id,
      gallery_images: [{ url: "https://cdn.meetmeatthefair.com/x.jpg", alt: "alt" }],
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["vendor-update"]);
  });

  it("editing slug fires vendor-update AND writes slug history", async () => {
    const id = seedVendor({ slug: "old-slug" });
    await adminServer.invoke("update_vendor", { vendor_id: id, slug: "new-branded-slug" });
    expect(mock.calls.map((c) => c.source)).toEqual(["vendor-update"]);

    const history = db
      .select()
      .from(vendorSlugHistory)
      .where(eq(vendorSlugHistory.vendorId, id))
      .all();
    expect(history).toHaveLength(1);
    expect(history[0].oldSlug).toBe("old-slug");
    expect(history[0].newSlug).toBe("new-branded-slug");
  });
});

describe("set_enhanced_profile", () => {
  it("active=true fires vendor-update AND sets flag/verified/timestamps", async () => {
    const id = seedVendor();
    await adminServer.invoke("set_enhanced_profile", { vendor_id: id, active: true });
    expect(mock.calls.map((c) => c.source)).toEqual(["vendor-update"]);

    const v = db.select().from(vendors).where(eq(vendors.id, id)).all()[0];
    expect(v.enhancedProfile).toBe(true);
    expect(v.verified).toBe(true);
    expect(v.enhancedProfileStartedAt).toBeTruthy();
    expect(v.enhancedProfileExpiresAt).toBeTruthy();
    // 365 days default
    const ms = (v.enhancedProfileExpiresAt as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(364 * 86400000);
    expect(ms).toBeLessThan(366 * 86400000);
  });

  it("active=false sets expires_at=now but does NOT immediately flip the flag", async () => {
    const id = seedVendor({ enhancedProfile: true });
    await adminServer.invoke("set_enhanced_profile", { vendor_id: id, active: false });

    const v = db.select().from(vendors).where(eq(vendors.id, id)).all()[0];
    // Flag stays on — daily sweep handles the 30-day grace.
    expect(v.enhancedProfile).toBe(true);
    expect((v.enhancedProfileExpiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("custom_slug change writes slug history row", async () => {
    const id = seedVendor({ slug: "auto-slug" });
    await adminServer.invoke("set_enhanced_profile", {
      vendor_id: id,
      active: true,
      custom_slug: "branded",
    });

    const history = db
      .select()
      .from(vendorSlugHistory)
      .where(eq(vendorSlugHistory.vendorId, id))
      .all();
    expect(history).toHaveLength(1);
    expect(history[0].oldSlug).toBe("auto-slug");
    expect(history[0].newSlug).toBe("branded");
  });

  it("writes an admin_actions audit row on activation", async () => {
    const id = seedVendor();
    await adminServer.invoke("set_enhanced_profile", { vendor_id: id, active: true });
    const actions = db.select().from(adminActions).where(eq(adminActions.targetId, id)).all();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("enhanced_profile.activate");
    expect(actions[0].targetType).toBe("vendor");
  });
});

// suggest_event (vendor.ts) ------------------------------------------------

describe("suggest_event", () => {
  beforeEach(() => {
    // suggest_event uses the well-known community-suggestions promoter id
    seedPromoter({ id: "system-community-suggestions", slug: "community-suggestions" });
    db.insert(users).values({ id: "u-vendor", email: "vendor@test", role: "VENDOR" }).run();
  });

  it("creating an event with a brand-new venue fires event-create AND venue-create", async () => {
    await vendorServer.invoke("suggest_event", {
      name: "Spring Craft Fair",
      venue_name: "Memorial Hall",
      venue_city: "Brunswick",
      venue_state: "ME",
      start_date: "2026-06-15",
      // bypass dupe detection: it uses a raw sql template that doesn't
      // round-trip Date objects through better-sqlite3's binder. Production
      // D1 handles this fine — it's a test-environment-only quirk.
      force_create: true,
    });
    const sources = mock.calls.map((c) => c.source).sort();
    expect(sources).toEqual(["event-create", "venue-create"]);
  });

  it("creating an event without a venue fires event-create only", async () => {
    await vendorServer.invoke("suggest_event", {
      name: "Open-air Festival",
      start_date: "2026-07-04",
      force_create: true,
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["event-create"]);
  });
});
