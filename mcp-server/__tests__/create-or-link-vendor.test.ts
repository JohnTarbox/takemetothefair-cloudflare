/**
 * Unit tests for the create_or_link_vendor MCP tool.
 *
 * Covers dedup strategy variants, redirect-chain resolution, event_vendors
 * upsert behavior, transition validation, lifecycle hooks, and audit logging.
 * Uses the same in-memory SQLite + CapturingMcpServer pattern as
 * indexnow-hooks.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, eventVendors, events, promoters, users, vendors } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  mock = mockIndexNowFetch();
});

afterEach(() => {
  mock.restore();
});

// Helpers ------------------------------------------------------------------

function seedPromoter() {
  db.insert(promoters)
    .values({ id: "promoter-1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
}

function seedEvent(overrides: Partial<typeof events.$inferInsert> = {}) {
  if (!overrides.promoterId) seedPromoter();
  const id = overrides.id ?? "event-1";
  db.insert(events)
    .values({
      id,
      name: overrides.name ?? "Test Event",
      slug: overrides.slug ?? "test-event",
      promoterId: overrides.promoterId ?? "promoter-1",
      status: "APPROVED",
      ...overrides,
    })
    .run();
  return id;
}

function seedVendor(overrides: Partial<typeof vendors.$inferInsert> = {}) {
  const userId = overrides.userId ?? `u-${overrides.id ?? "v"}`;
  db.insert(users)
    .values({ id: userId, email: `${userId}@test`, role: "VENDOR" })
    .run();
  const id = overrides.id ?? "vendor-1";
  db.insert(vendors)
    .values({
      id,
      userId,
      businessName: overrides.businessName ?? "Test Vendor",
      slug: overrides.slug ?? `slug-${id}`,
      ...overrides,
    })
    .run();
  return id;
}

type CreateOrLinkPayload = {
  vendor_id: string;
  was_created: boolean;
  was_linked: boolean;
  was_already_linked: boolean;
  status_changed: boolean;
  matched_existing: { name: string; similarity_score: number | null } | null;
};

async function invoke(args: Record<string, unknown>) {
  const result = (await server.invoke("create_or_link_vendor", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    raw: result,
    isError: !!result.isError,
    payload: result.isError ? null : (JSON.parse(result.content[0].text) as CreateOrLinkPayload),
    errorText: result.isError ? result.content[0].text : null,
  };
}

// 1. Event not found --------------------------------------------------------

describe("event resolution", () => {
  it("returns isError when event_id doesn't exist", async () => {
    const { isError, errorText } = await invoke({
      event_id: "missing-event",
      business_name: "Anywhere",
    });
    expect(isError).toBe(true);
    expect(errorText).toContain("Event not found");
  });
});

// 2. New vendor + new link --------------------------------------------------

describe("new vendor + new link", () => {
  it("creates vendor, inserts event_vendors row, returns was_created+was_linked", async () => {
    const eid = seedEvent();
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Brand New Vendor LLC",
      type: "Crafts",
      status: "CONFIRMED",
    });
    expect(payload?.was_created).toBe(true);
    expect(payload?.was_linked).toBe(true);
    expect(payload?.was_already_linked).toBe(false);
    expect(payload?.status_changed).toBe(false);
    expect(payload?.matched_existing).toBeNull();

    // Verify vendor row and link
    const v = db.select().from(vendors).where(eq(vendors.id, payload!.vendor_id)).all();
    expect(v).toHaveLength(1);
    expect(v[0].businessName).toBe("Brand New Vendor LLC");
    const link = db
      .select()
      .from(eventVendors)
      .where(eq(eventVendors.vendorId, payload!.vendor_id))
      .all();
    expect(link).toHaveLength(1);
    expect(link[0].status).toBe("CONFIRMED");
  });

  it("fires both vendor-create-or-link AND event-vendor-link IndexNow pings", async () => {
    const eid = seedEvent();
    await invoke({
      event_id: eid,
      business_name: "Roger's Photography",
      type: "Photography",
      status: "CONFIRMED",
    });
    const sources = mock.calls.map((c) => c.source).sort();
    expect(sources).toEqual(["event-vendor-link", "vendor-create-or-link"]);
  });
});

// 3. Strict dedup -----------------------------------------------------------

describe("dedup_strategy: 'strict'", () => {
  it("matches case-insensitive exact business name and skips creation", async () => {
    const eid = seedEvent();
    seedVendor({ id: "existing", businessName: "Acme Catering Co", slug: "acme-catering" });
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Acme Catering Co",
      dedup_strategy: "strict",
    });
    expect(payload?.was_created).toBe(false);
    expect(payload?.vendor_id).toBe("existing");
    expect(payload?.was_linked).toBe(true);
  });

  it("near-match with different punctuation does NOT match in strict mode", async () => {
    const eid = seedEvent();
    seedVendor({ id: "existing", businessName: "Acme Catering Co.", slug: "acme-catering" });
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Acme Catering Co",
      dedup_strategy: "strict",
    });
    expect(payload?.was_created).toBe(true);
    expect(payload?.vendor_id).not.toBe("existing");
  });

  it("does NOT match soft-deleted vendor", async () => {
    const eid = seedEvent();
    seedVendor({
      id: "softdeleted",
      businessName: "Old Vendor Inc",
      slug: "old-vendor",
      deletedAt: new Date(),
    });
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Old Vendor Inc",
      dedup_strategy: "strict",
    });
    expect(payload?.was_created).toBe(true);
    expect(payload?.vendor_id).not.toBe("softdeleted");
  });
});

// 4. Fuzzy dedup ------------------------------------------------------------

describe("dedup_strategy: 'fuzzy' (default)", () => {
  it("matches near-identical business name above threshold", async () => {
    const eid = seedEvent();
    seedVendor({
      id: "existing",
      businessName: "Renewal by Andersen of Southern New England",
      slug: "renewal-by-andersen-of-southern-new-england",
      vendorType: "Home Improvement",
    });
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Renewal by Andersen of Southern New England",
      type: "Home Improvement",
    });
    expect(payload?.was_created).toBe(false);
    expect(payload?.vendor_id).toBe("existing");
    expect(payload?.matched_existing?.name).toBe("Renewal by Andersen of Southern New England");
    expect(payload?.matched_existing?.similarity_score).toBeGreaterThanOrEqual(0.92);
  });

  it("falls through to create when no candidates exceed threshold", async () => {
    const eid = seedEvent();
    seedVendor({
      id: "existing",
      businessName: "Completely Unrelated Plumbing",
      slug: "completely-unrelated-plumbing",
    });
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Stellar Bridal Bouquets",
    });
    expect(payload?.was_created).toBe(true);
    expect(payload?.vendor_id).not.toBe("existing");
  });
});

// 5. Skip strategy ----------------------------------------------------------

describe("dedup_strategy: 'skip'", () => {
  it("creates new vendor even when exact match exists", async () => {
    const eid = seedEvent();
    seedVendor({ id: "existing", businessName: "Dup Allowed", slug: "dup-allowed" });
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Dup Allowed",
      dedup_strategy: "skip",
    });
    expect(payload?.was_created).toBe(true);
    expect(payload?.vendor_id).not.toBe("existing");
    // Verify both rows exist
    const all = db.select().from(vendors).where(eq(vendors.businessName, "Dup Allowed")).all();
    expect(all).toHaveLength(2);
  });
});

// 6. Existing link, idempotent --------------------------------------------

describe("existing event_vendors link", () => {
  it("idempotent: same status returns was_already_linked, no DB change", async () => {
    const eid = seedEvent();
    const vid = seedVendor({ businessName: "Idem Vendor", slug: "idem-vendor" });
    db.insert(eventVendors)
      .values({
        id: "ev-1",
        eventId: eid,
        vendorId: vid,
        status: "CONFIRMED",
        paymentStatus: "NOT_REQUIRED",
      })
      .run();

    const { payload } = await invoke({
      event_id: eid,
      business_name: "Idem Vendor",
      dedup_strategy: "strict",
      status: "CONFIRMED",
    });
    expect(payload?.was_already_linked).toBe(true);
    expect(payload?.was_linked).toBe(false);
    expect(payload?.status_changed).toBe(false);

    const link = db.select().from(eventVendors).where(eq(eventVendors.id, "ev-1")).all();
    expect(link[0].status).toBe("CONFIRMED");
  });

  it("status change with valid transition: status_changed=true", async () => {
    const eid = seedEvent();
    const vid = seedVendor({ businessName: "Trans Vendor", slug: "trans-vendor" });
    db.insert(eventVendors)
      .values({
        id: "ev-2",
        eventId: eid,
        vendorId: vid,
        status: "APPROVED",
        paymentStatus: "NOT_REQUIRED",
      })
      .run();

    const { payload } = await invoke({
      event_id: eid,
      business_name: "Trans Vendor",
      dedup_strategy: "strict",
      status: "CONFIRMED",
    });
    expect(payload?.was_already_linked).toBe(true);
    expect(payload?.status_changed).toBe(true);

    const link = db.select().from(eventVendors).where(eq(eventVendors.id, "ev-2")).all();
    expect(link[0].status).toBe("CONFIRMED");
  });

  it("rejects invalid transition", async () => {
    const eid = seedEvent();
    const vid = seedVendor({ businessName: "Invalid Vendor", slug: "invalid-vendor" });
    db.insert(eventVendors)
      .values({
        id: "ev-3",
        eventId: eid,
        vendorId: vid,
        status: "REJECTED",
        paymentStatus: "NOT_REQUIRED",
      })
      .run();

    const { isError, errorText } = await invoke({
      event_id: eid,
      business_name: "Invalid Vendor",
      dedup_strategy: "strict",
      status: "CONFIRMED",
    });
    expect(isError).toBe(true);
    expect(errorText).toContain("Invalid transition");
  });
});

// 7. Redirect chain --------------------------------------------------------

describe("redirect_to_vendor_id chain", () => {
  it("resolves to canonical vendor when matched row has redirect set", async () => {
    const eid = seedEvent();
    const canonicalId = seedVendor({
      id: "canonical",
      businessName: "Canonical Vendor",
      slug: "canonical-vendor",
    });
    seedVendor({
      id: "alias",
      businessName: "Old Aliased Name",
      slug: "old-aliased-name",
      redirectToVendorId: canonicalId,
    });

    const { payload } = await invoke({
      event_id: eid,
      business_name: "Old Aliased Name",
      dedup_strategy: "strict",
    });
    expect(payload?.was_created).toBe(false);
    expect(payload?.vendor_id).toBe(canonicalId);
    expect(payload?.matched_existing?.name).toBe("Canonical Vendor");
  });

  it("rejects cyclical redirect", async () => {
    const eid = seedEvent();
    seedVendor({
      id: "v-a",
      businessName: "Cycle A",
      slug: "cycle-a",
      redirectToVendorId: "v-b",
    });
    seedVendor({
      id: "v-b",
      businessName: "Cycle B",
      slug: "cycle-b",
      redirectToVendorId: "v-a",
    });

    const { isError, errorText } = await invoke({
      event_id: eid,
      business_name: "Cycle A",
      dedup_strategy: "strict",
    });
    expect(isError).toBe(true);
    expect(errorText).toContain("alias_cycle_detected");
  });
});

// 8. Audit log -------------------------------------------------------------

describe("audit log", () => {
  it("writes admin_actions row with full payload", async () => {
    const eid = seedEvent();
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Audit Vendor",
      type: "Test",
      status: "CONFIRMED",
    });
    const rows = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "event_vendor.create_or_link"))
      .all();
    expect(rows).toHaveLength(1);
    const audit = rows[0];
    expect(audit.targetType).toBe("event_vendor");
    expect(audit.actorUserId).toBe("u-admin");
    const parsed = JSON.parse(audit.payloadJson!);
    expect(parsed.event_id).toBe(eid);
    expect(parsed.vendor_id).toBe(payload!.vendor_id);
    expect(parsed.was_created).toBe(true);
    expect(parsed.was_linked).toBe(true);
    expect(parsed.dedup_strategy).toBe("fuzzy");
  });
});

// 9. defer_search_ping flag ------------------------------------------------

describe("defer_search_ping flag (PR 1 plumbing only)", () => {
  it("suppresses inline IndexNow when true", async () => {
    const eid = seedEvent();
    await invoke({
      event_id: eid,
      business_name: "Quiet Vendor",
      defer_search_ping: true,
    });
    expect(mock.calls).toHaveLength(0);
  });
});

// 10. non-public status does not ping the event page ----------------------

describe("non-public status linking", () => {
  it("INVITED link to existing vendor does not ping event page", async () => {
    const eid = seedEvent();
    seedVendor({ id: "existing", businessName: "Linked Vendor", slug: "linked-vendor" });
    await invoke({
      event_id: eid,
      business_name: "Linked Vendor",
      dedup_strategy: "strict",
      status: "INVITED",
    });
    // No vendor-create-or-link (vendor already existed) AND no event-vendor-link (INVITED isn't public).
    expect(mock.calls).toHaveLength(0);
  });
});

// 11. sanitization ---------------------------------------------------------

describe("input sanitization", () => {
  it("decodes &amp; in business_name so dedup matches the literal '&' row", async () => {
    const eid = seedEvent();
    seedVendor({
      id: "existing",
      businessName: "Earth Expo & Convention Center",
      slug: "earth-expo-and-convention-center",
    });
    const { payload } = await invoke({
      event_id: eid,
      business_name: "Earth Expo &amp; Convention Center",
      dedup_strategy: "strict",
    });
    expect(payload?.was_created).toBe(false);
    expect(payload?.vendor_id).toBe("existing");
  });
});
