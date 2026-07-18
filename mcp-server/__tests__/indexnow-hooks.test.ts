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
  eventSlugHistory,
  adminActions,
  pendingSearchPings,
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
      // OPE-244 #3 — the approval gate refuses venue-less non-statewide events.
      // These fixtures test IndexNow ping behavior, not the location gate, so
      // mark them statewide (with a state) to keep them approvable.
      isStatewide: true,
      stateCode: "ME",
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
  // REL4: every write path now defers the IndexNow ping by default. These tests
  // assert the SOURCE-LABEL wiring (the round-2 regression contract), which only
  // exists on the inline path — the deferred pending row carries entity metadata,
  // not a source label. So they pass defer_search_ping:false to exercise inline.
  // The default-defers-to-pending behavior is covered in the REL4 block below.
  it("DRAFT → APPROVED fires event-create", async () => {
    const id = seedEvent({ status: "DRAFT" });
    await adminServer.invoke("update_event_status", {
      event_id: id,
      status: "APPROVED",
      defer_search_ping: false,
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].source).toBe("event-create");
    expect(mock.calls[0].urls[0]).toContain("/events/test-event");
  });

  it("OPE-244 #3 — REFUSES APPROVED for a venue-less non-statewide event, no ping", async () => {
    const id = seedEvent({ status: "DRAFT", isStatewide: false, stateCode: null, venueId: null });
    const res = await adminServer.invoke("update_event_status", {
      event_id: id,
      status: "APPROVED",
      defer_search_ping: false,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("no venue");
    expect(mock.calls).toHaveLength(0); // blocked before the ping
  });

  it("OPE-244 #3 — ALLOWS APPROVED for a venue-less STATEWIDE event with a state", async () => {
    const id = seedEvent({ status: "DRAFT", isStatewide: true, stateCode: "ME", venueId: null });
    const res = await adminServer.invoke("update_event_status", {
      event_id: id,
      status: "APPROVED",
      defer_search_ping: false,
    });
    expect(res.isError).toBeFalsy();
    expect(mock.calls).toHaveLength(1);
  });

  it("DRAFT → TENTATIVE fires event-create (TENTATIVE is publicly visible)", async () => {
    const id = seedEvent({ status: "DRAFT" });
    await adminServer.invoke("update_event_status", {
      event_id: id,
      status: "TENTATIVE",
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["event-create"]);
  });

  it("TENTATIVE → APPROVED fires event-approve (the round-2 bug)", async () => {
    const id = seedEvent({ status: "TENTATIVE", slug: "fiddlehead-festival" });
    await adminServer.invoke("update_event_status", {
      event_id: id,
      status: "APPROVED",
      defer_search_ping: false,
    });
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
  // REL4 (2026-06-13) — update_event now defers the IndexNow ping by default
  // (defer_search_ping=true) to batch operator edit sessions and avoid the Bing
  // 429 storm. A material edit on a public event enqueues a pending_search_pings
  // row rather than firing inline; the hourly cron / flush drains it.
  it("editing description on APPROVED event enqueues a deferred event-update ping", async () => {
    const id = seedEvent({ status: "APPROVED", description: "old" });
    await adminServer.invoke("update_event", { event_id: id, description: "new and better" });
    // Deferred: no inline call…
    expect(mock.calls).toHaveLength(0);
    // …but a pending row queued for the event.
    const pending = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.entityId, id))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0].entityType).toBe("event");
  });

  it("defer_search_ping:false still fires the inline event-update ping (escape hatch)", async () => {
    const id = seedEvent({ status: "APPROVED", description: "old" });
    await adminServer.invoke("update_event", {
      event_id: id,
      description: "now please index immediately",
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["event-update"]);
  });

  it("editing only featured (non-material) does NOT ping or enqueue", async () => {
    const id = seedEvent({ status: "APPROVED" });
    await adminServer.invoke("update_event", { event_id: id, featured: true });
    expect(mock.calls).toHaveLength(0);
    expect(db.select().from(pendingSearchPings).all()).toHaveLength(0);
  });

  it("editing description on DRAFT event does NOT ping or enqueue (event isn't public yet)", async () => {
    const id = seedEvent({ status: "DRAFT" });
    await adminServer.invoke("update_event", { event_id: id, description: "anything" });
    expect(mock.calls).toHaveLength(0);
    expect(db.select().from(pendingSearchPings).all()).toHaveLength(0);
  });

  // Slug param (mirrors update_vendor) — added with the analyst's
  // "rename without orphaning GSC impressions" request.
  it("slug param alone writes event_slug_history without changing name", async () => {
    const id = seedEvent({ status: "APPROVED", slug: "old-event-slug" });
    await adminServer.invoke("update_event", { event_id: id, slug: "branded-event-slug" });
    const e = db.select().from(events).where(eq(events.id, id)).all()[0];
    expect(e.slug).toBe("branded-event-slug");
    expect(e.name).toBe("Test Event"); // seedEvent default
    const history = db
      .select()
      .from(eventSlugHistory)
      .where(eq(eventSlugHistory.eventId, id))
      .all();
    expect(history).toHaveLength(1);
    expect(history[0].oldSlug).toBe("old-event-slug");
    expect(history[0].newSlug).toBe("branded-event-slug");
  });

  it("explicit slug takes priority over name-derived auto-regen", async () => {
    const id = seedEvent({ status: "APPROVED", slug: "old-event-slug" });
    await adminServer.invoke("update_event", {
      event_id: id,
      name: "Brand New Name",
      slug: "explicit-slug",
    });
    const e = db.select().from(events).where(eq(events.id, id)).all()[0];
    expect(e.name).toBe("Brand New Name");
    expect(e.slug).toBe("explicit-slug"); // not "brand-new-name"
    const history = db
      .select()
      .from(eventSlugHistory)
      .where(eq(eventSlugHistory.eventId, id))
      .all();
    expect(history).toHaveLength(1);
    expect(history[0].newSlug).toBe("explicit-slug");
  });

  it("name change with no slug param still auto-regenerates (backwards compat)", async () => {
    const id = seedEvent({ status: "APPROVED", slug: "old-event-slug" });
    await adminServer.invoke("update_event", { event_id: id, name: "Brand New Name" });
    const e = db.select().from(events).where(eq(events.id, id)).all()[0];
    expect(e.slug).toBe("brand-new-name");
    const history = db
      .select()
      .from(eventSlugHistory)
      .where(eq(eventSlugHistory.eventId, id))
      .all();
    expect(history).toHaveLength(1);
    expect(history[0].oldSlug).toBe("old-event-slug");
    expect(history[0].newSlug).toBe("brand-new-name");
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
      defer_search_ping: false,
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
    await adminServer.invoke("update_venue", {
      venue_id: id,
      status: "ACTIVE",
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["venue-activate"]);
  });

  it("editing address on ACTIVE venue fires venue-update", async () => {
    const id = seedVenue({ status: "ACTIVE" });
    await adminServer.invoke("update_venue", {
      venue_id: id,
      address: "200 New Rd",
      defer_search_ping: false,
    });
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
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["vendor-create"]);
  });
});

describe("update_vendor", () => {
  it("editing vendor_type fires vendor-update", async () => {
    const id = seedVendor();
    await adminServer.invoke("update_vendor", {
      vendor_id: id,
      vendor_type: "Crafts",
      defer_search_ping: false,
    });
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
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["vendor-update"]);
  });

  it("editing slug fires vendor-update AND writes slug history", async () => {
    const id = seedVendor({ slug: "old-slug" });
    await adminServer.invoke("update_vendor", {
      vendor_id: id,
      slug: "new-branded-slug",
      defer_search_ping: false,
    });
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
    await adminServer.invoke("set_enhanced_profile", {
      vendor_id: id,
      active: true,
      defer_search_ping: false,
    });
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

// REL4 defer-by-default --------------------------------------------------------
// The reopen fix: every MCP write path defaults defer_search_ping=true so bursty
// create flows (the daily discovery cron) enqueue to pending_search_pings and the
// hourly cron coalesces them into ONE batched call, instead of firing a storm of
// single-URL inline pings that re-armed Bing's per-host 429 penalty.

describe("REL4 defer-by-default (no defer_search_ping passed)", () => {
  it("create_venue enqueues a pending row instead of pinging inline", async () => {
    await adminServer.invoke("create_venue", {
      name: "Deferred Hall",
      address: "5 Quiet Way",
      city: "Bangor",
      state: "ME",
      zip: "04401",
    });
    expect(mock.calls).toHaveLength(0);
    const pending = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.entityType, "venue"))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0].action).toBe("create");
  });

  it("create_vendor enqueues a pending row instead of pinging inline", async () => {
    await adminServer.invoke("create_vendor", {
      business_name: "Quiet Crafts Co",
      type: "Crafts",
      products: ["candles"],
      location: "Augusta, ME",
    });
    expect(mock.calls).toHaveLength(0);
    const pending = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.entityType, "vendor"))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0].action).toBe("create");
  });

  it("update_event_status DRAFT → APPROVED enqueues instead of pinging inline", async () => {
    const id = seedEvent({ status: "DRAFT" });
    await adminServer.invoke("update_event_status", { event_id: id, status: "APPROVED" });
    expect(mock.calls).toHaveLength(0);
    const pending = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.entityId, id))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0].entityType).toBe("event");
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
      defer_search_ping: false,
    });
    const sources = mock.calls.map((c) => c.source).sort();
    expect(sources).toEqual(["event-create", "venue-create"]);
  });

  it("creating an event without a venue fires event-create only", async () => {
    await vendorServer.invoke("suggest_event", {
      name: "Open-air Festival",
      start_date: "2026-07-04",
      force_create: true,
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source)).toEqual(["event-create"]);
  });

  // Regression for issue #120: suggest_event used an inline naive slug regex
  // while create_venue used canonical createSlug. For names with "&" the two
  // produced different slugs (canonical inserts "and"), so the dedup SELECT
  // missed the existing row and a duplicate venue was created.
  it("dedups against canonical-slug venue when name contains '&'", async () => {
    seedVenue({
      id: "venue-existing-amp",
      name: "Capital City Sports & Fitness",
      slug: "capital-city-sports-and-fitness",
      city: "Concord",
      state: "NH",
    });
    await vendorServer.invoke("suggest_event", {
      name: "Holiday Show",
      venue_name: "Capital City Sports & Fitness",
      venue_city: "Concord",
      venue_state: "NH",
      start_date: "2026-12-15",
      force_create: true,
      defer_search_ping: false,
    });
    const sources = mock.calls.map((c) => c.source).sort();
    // venue-create MUST NOT fire — the existing row should match.
    expect(sources).toEqual(["event-create"]);

    // Verify no second row was inserted under any slug variant.
    const rows = db
      .select({ id: venues.id, slug: venues.slug })
      .from(venues)
      .where(eq(venues.name, "Capital City Sports & Fitness"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("venue-existing-amp");
  });

  // Sibling case: apostrophe handling differs between canonical (drops it
  // entirely → "robin-hoods-...") and the old inline regex (treats it as a
  // separator → "robin-hood-s-..."). Confirms the dedup is now consistent.
  it("dedups against canonical-slug venue when name contains an apostrophe", async () => {
    seedVenue({
      id: "venue-existing-apos",
      name: "Robin Hood's Faire Grounds",
      slug: "robin-hoods-faire-grounds",
      city: "Harwinton",
      state: "CT",
    });
    await vendorServer.invoke("suggest_event", {
      name: "Renaissance Weekend",
      venue_name: "Robin Hood's Faire Grounds",
      venue_city: "Harwinton",
      venue_state: "CT",
      start_date: "2026-09-12",
      force_create: true,
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source).sort()).toEqual(["event-create"]);
    const rows = db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.name, "Robin Hood's Faire Grounds"))
      .all();
    expect(rows).toHaveLength(1);
  });

  // Inverse of the canonical-slug case above: a venue created BEFORE the
  // canonical generator rolled out can have a stored slug that strips "&"
  // entirely (legacy regex behavior). For canonical `createSlug` the same
  // name produces "earth-expo-AND-convention-..." — so slug-only matching
  // misses the row entirely and silently creates a duplicate.
  //
  // Bug surfaced 2026-05-26 in a CT discovery session: 3 duplicate
  // "Earth Expo & Convention Center at Mohegan Sun" venues were created
  // and had to be cleaned up. Fix is a name-equality fallback alongside
  // the slug lookup in the venue resolver.
  it("dedups against legacy-slug venue whose stored slug pre-dates current createSlug", async () => {
    seedVenue({
      id: "venue-existing-legacy-amp",
      name: "Earth Expo & Convention Center at Mohegan Sun",
      // Legacy slug: stored before slugify expanded "&" to "and". The
      // current canonical createSlug for this name would emit
      // "earth-expo-and-convention-center-at-mohegan-sun" instead.
      slug: "earth-expo-convention-center-at-mohegan-sun",
      city: "Uncasville",
      state: "CT",
    });
    await vendorServer.invoke("suggest_event", {
      name: "NE Christmas Festival 2026",
      venue_name: "Earth Expo & Convention Center at Mohegan Sun",
      venue_city: "Uncasville",
      venue_state: "CT",
      start_date: "2026-12-05",
      force_create: true,
      defer_search_ping: false,
    });
    // venue-create MUST NOT fire — the legacy-slug row should be matched
    // by the name-equality fallback in the resolver.
    expect(mock.calls.map((c) => c.source).sort()).toEqual(["event-create"]);

    const rows = db
      .select({ id: venues.id, slug: venues.slug })
      .from(venues)
      .where(eq(venues.name, "Earth Expo & Convention Center at Mohegan Sun"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("venue-existing-legacy-amp");
    // The legacy slug stays — fix should not rewrite existing rows.
    expect(rows[0].slug).toBe("earth-expo-convention-center-at-mohegan-sun");
  });

  // ── K44 (2026-06-25) — orphan-venue dedup ──────────────────────────
  // The orphan-litter bug: a slug/name match was only reused when its city
  // (or state) ALSO agreed. A suggestion carrying a city the stored row left
  // blank fell through to CREATE a duplicate (Fitzwilliam Common, Cape
  // Elizabeth Town Center, …). Now any candidate is reused.
  it("K44: reuses a name-matched venue even when the stored row has no city", async () => {
    seedVenue({
      id: "venue-cape-elizabeth",
      name: "Cape Elizabeth Town Center",
      slug: "cape-elizabeth-town-center",
      city: "", // stored row left city blank — the orphan-bug trigger
      state: "",
    });
    await vendorServer.invoke("suggest_event", {
      name: "Strawberry Festival",
      venue_name: "Cape Elizabeth Town Center",
      venue_city: "Cape Elizabeth",
      venue_state: "ME",
      start_date: "2026-06-27",
      force_create: true,
      defer_search_ping: false,
    });
    // No venue-create — the existing row must be reused despite the city gap.
    expect(mock.calls.map((c) => c.source).sort()).toEqual(["event-create"]);
    const rows = db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.name, "Cape Elizabeth Town Center"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("venue-cape-elizabeth");
  });

  it("K44: matches a venue across trailing-punctuation name variants", async () => {
    seedVenue({
      id: "venue-fitzwilliam",
      name: "Fitzwilliam Common",
      slug: "fitzwilliam-common",
      city: "Fitzwilliam",
      state: "NH",
    });
    await vendorServer.invoke("suggest_event", {
      name: "Apple Harvest Day",
      venue_name: "Fitzwilliam Common.", // trailing period variant
      venue_city: "Fitzwilliam",
      venue_state: "NH",
      start_date: "2026-10-03",
      force_create: true,
      defer_search_ping: false,
    });
    expect(mock.calls.map((c) => c.source).sort()).toEqual(["event-create"]);
    const rows = db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.name, "Fitzwilliam Common"))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("K44: explicit venue_id links directly and skips name-matching/creation", async () => {
    const vid = seedVenue({
      id: "venue-explicit",
      name: "Greenfield Fairgrounds",
      slug: "greenfield-fairgrounds",
      city: "Greenfield",
      state: "MA",
    });
    await vendorServer.invoke("suggest_event", {
      name: "Franklin County Fair",
      venue_id: vid,
      // A venue_name that would otherwise NOT match anything — must be ignored.
      venue_name: "Totally Different Place",
      start_date: "2026-09-17",
      force_create: true,
      defer_search_ping: false,
    });
    // Only event-create — venue_id path creates no venue.
    expect(mock.calls.map((c) => c.source).sort()).toEqual(["event-create"]);
    const rows = db.select({ id: venues.id }).from(venues).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("venue-explicit");
  });

  it("K44: errors when an explicit venue_id does not exist", async () => {
    const res = await vendorServer.invoke("suggest_event", {
      name: "Phantom Fair",
      venue_id: "does-not-exist",
      start_date: "2026-08-01",
      force_create: true,
      defer_search_ping: false,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("Venue not found");
  });
});
