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
import {
  adminActions,
  eventDays,
  eventVendors,
  events,
  promoters,
  users,
  vendors,
} from "../src/schema.js";

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
    // REL4: create_or_link_vendor now defers by default; pass false to assert the
    // inline source-label wiring (the deferred pending row carries no source label).
    await invoke({
      event_id: eid,
      business_name: "Roger's Photography",
      type: "Photography",
      status: "CONFIRMED",
      defer_search_ping: false,
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

// 12. regression: schema-drift / deploy-skew protection -------------------
//
// 2026-06-05: A `D1_ERROR: table vendors has no column named parent_vendor_id`
// hit the live MCP tool during the EH1 Phase 1 deploy window (PRs #339 →
// #343). The 0106 → 0107 migration renamed `parent_vendor_id` to
// `brand_parent_vendor_id`; prod DB applied 0107 before the MCP Worker
// redeploy caught up, so the deployed Worker's bare-select SQL referenced
// the old column name against the new schema. Source is clean now (no bare
// `db.select().from(vendors)` in the match path), but pin the literal
// failure-mode shape so any future bare-select regression surfaces here
// rather than against operator traffic.
describe("regression: match-existing on Maine Cardworks shape (2026-06-05)", () => {
  it("links to an existing vendor via strict + fuzzy match without DB errors", async () => {
    const eid = seedEvent();
    seedVendor({
      id: "adc1d1b4",
      businessName: "Maine Cardworks Inc",
      slug: "maine-cardworks-inc",
      vendorType: "Crafts",
    });

    // Strict path
    const strict = await invoke({
      event_id: eid,
      business_name: "Maine Cardworks Inc",
      dedup_strategy: "strict",
    });
    expect(strict.isError).toBe(false);
    expect(strict.payload?.was_created).toBe(false);
    expect(strict.payload?.vendor_id).toBe("adc1d1b4");
    expect(strict.payload?.was_linked).toBe(true);

    // Fuzzy path against the same row from a second event
    const eid2 = seedEvent({
      id: "event-2",
      slug: "test-event-2",
      promoterId: "promoter-1",
    });
    const fuzzy = await invoke({
      event_id: eid2,
      business_name: "Maine Cardworks Inc.",
      type: "Crafts",
      dedup_strategy: "fuzzy",
    });
    expect(fuzzy.isError).toBe(false);
    expect(fuzzy.payload?.was_created).toBe(false);
    expect(fuzzy.payload?.vendor_id).toBe("adc1d1b4");
  });
});

// K18 Phase 1 — per-occurrence vendor links (drizzle/0114) -------------------

function seedEventDay(eventId: string, id: string, date: string) {
  db.insert(eventDays).values({ id, eventId, date, openTime: "10:00", closeTime: "18:00" }).run();
  return id;
}

describe("K18 Phase 1 — event_day_id scoping", () => {
  it("links a vendor series-wide by default (event_day_id omitted)", async () => {
    const eid = seedEvent();
    const { payload, isError } = await invoke({
      event_id: eid,
      business_name: "Series-wide Vendor",
    });
    expect(isError).toBe(false);
    expect(payload?.was_linked).toBe(true);
    const rows = db.select().from(eventVendors).where(eq(eventVendors.eventId, eid)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventDayId).toBeNull();
  });

  it("scopes the link to a specific event_day when event_day_id is set", async () => {
    const eid = seedEvent();
    const dayId = seedEventDay(eid, "day-1", "2026-07-04");
    const { payload, isError } = await invoke({
      event_id: eid,
      business_name: "Per-Day Vendor",
      event_day_id: dayId,
    });
    expect(isError).toBe(false);
    expect(payload?.was_linked).toBe(true);
    const rows = db.select().from(eventVendors).where(eq(eventVendors.eventId, eid)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventDayId).toBe(dayId);
  });

  it("allows a vendor to have BOTH a series-wide link AND a per-day link", async () => {
    // The partial unique indexes treat NULL eventDayId as a distinct slot
    // from any non-NULL — so "regular participant, plus has a featured slot
    // on Jul 4" semantics work without manual deduplication.
    const eid = seedEvent();
    const dayId = seedEventDay(eid, "day-1", "2026-07-04");

    const seriesWide = await invoke({ event_id: eid, business_name: "Hybrid Vendor" });
    expect(seriesWide.isError).toBe(false);
    expect(seriesWide.payload?.was_linked).toBe(true);

    const perDay = await invoke({
      event_id: eid,
      business_name: "Hybrid Vendor",
      event_day_id: dayId,
      dedup_strategy: "strict",
    });
    expect(perDay.isError).toBe(false);
    expect(perDay.payload?.was_linked).toBe(true);
    // Both rows should exist for the same (event, vendor) — separated only
    // by event_day_id (NULL vs the day uuid).
    const rows = db.select().from(eventVendors).where(eq(eventVendors.eventId, eid)).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.eventDayId === null)).toBe(true);
    expect(rows.some((r) => r.eventDayId === dayId)).toBe(true);
  });

  it("re-running the same series-wide call is idempotent (was_already_linked)", async () => {
    // The dedup query keys on (event_id, vendor_id, IS NULL event_day_id)
    // for the second call, finds the first row, and returns the existing
    // link rather than failing on the partial-unique-index.
    const eid = seedEvent();
    const first = await invoke({ event_id: eid, business_name: "Repeat Vendor" });
    expect(first.payload?.was_linked).toBe(true);
    const second = await invoke({
      event_id: eid,
      business_name: "Repeat Vendor",
      dedup_strategy: "strict",
    });
    expect(second.isError).toBe(false);
    expect(second.payload?.was_already_linked).toBe(true);
    expect(second.payload?.was_linked).toBe(false);
    const rows = db.select().from(eventVendors).where(eq(eventVendors.eventId, eid)).all();
    expect(rows).toHaveLength(1);
  });

  it("re-running the same per-day call is idempotent", async () => {
    const eid = seedEvent();
    const dayId = seedEventDay(eid, "day-1", "2026-07-04");
    const first = await invoke({
      event_id: eid,
      business_name: "Repeat Per-Day Vendor",
      event_day_id: dayId,
    });
    expect(first.payload?.was_linked).toBe(true);
    const second = await invoke({
      event_id: eid,
      business_name: "Repeat Per-Day Vendor",
      event_day_id: dayId,
      dedup_strategy: "strict",
    });
    expect(second.isError).toBe(false);
    expect(second.payload?.was_already_linked).toBe(true);
    const rows = db.select().from(eventVendors).where(eq(eventVendors.eventId, eid)).all();
    expect(rows).toHaveLength(1);
  });

  it("rejects an event_day_id that doesn't exist", async () => {
    const eid = seedEvent();
    const { isError, errorText } = await invoke({
      event_id: eid,
      business_name: "Missing Day Vendor",
      event_day_id: "nonexistent-day-id",
    });
    expect(isError).toBe(true);
    expect(errorText).toContain("event_day_id not found");
  });

  it("rejects an event_day_id that belongs to a different event", async () => {
    seedEvent({ id: "event-A", slug: "ev-a" });
    const eidB = seedEvent({ id: "event-B", slug: "ev-b", promoterId: "promoter-1" });
    const dayOfA = seedEventDay("event-A", "day-of-a", "2026-08-01");
    const { isError, errorText } = await invoke({
      event_id: eidB,
      business_name: "Cross-Event Vendor",
      event_day_id: dayOfA,
    });
    expect(isError).toBe(true);
    expect(errorText).toContain("Cross-event scoping is not allowed");
  });

  it("supports two vendors on the same event_day (partial unique allows distinct vendor_ids)", async () => {
    const eid = seedEvent();
    const dayId = seedEventDay(eid, "day-1", "2026-07-04");
    const a = await invoke({ event_id: eid, business_name: "Vendor A", event_day_id: dayId });
    const b = await invoke({ event_id: eid, business_name: "Vendor B", event_day_id: dayId });
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(a.payload?.was_linked).toBe(true);
    expect(b.payload?.was_linked).toBe(true);
    const rows = db.select().from(eventVendors).where(eq(eventVendors.eventId, eid)).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.eventDayId === dayId)).toBe(true);
  });
});

// I1 Trigger 1 — post-create enrichment enqueue --------------------------------
//
// When create_or_link_vendor CREATES a new vendor that has a website, it
// fire-and-forget enqueues a fill-empty enrichment job so the contact fields
// get populated without waiting for the nightly cron. Matched (existing)
// vendors and websiteless new vendors must NOT enqueue. dryRun mirrors the
// ENRICHMENT_DRY_RUN operator switch. A queue hiccup must never fail the create.

type EnrichMsg = { vendorId: string; jobRunId: string; dryRun: boolean };

/** Build a fresh server bound to an env carrying a capturing enrichment queue. */
function makeServerWithQueue(opts: { dryRunVar?: string; throwOnSend?: boolean } = {}) {
  const sent: EnrichMsg[] = [];
  const queue = {
    send: async (msg: EnrichMsg) => {
      if (opts.throwOnSend) throw new Error("queue unavailable");
      sent.push(msg);
    },
  };
  const env = {
    MAIN_APP_URL: "https://meetmeatthefair.com",
    INTERNAL_API_KEY: "test-key",
    VENDOR_ENRICHMENT: queue,
    ...(opts.dryRunVar !== undefined ? { ENRICHMENT_DRY_RUN: opts.dryRunVar } : {}),
  };
  const srv = new CapturingMcpServer();
  registerAdminTools(srv as never, db, ADMIN_AUTH, env as never);
  return { srv, sent };
}

async function invokeOn(srv: CapturingMcpServer, args: Record<string, unknown>) {
  const result = (await srv.invoke("create_or_link_vendor", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    isError: !!result.isError,
    payload: result.isError ? null : (JSON.parse(result.content[0].text) as CreateOrLinkPayload),
  };
}

describe("I1 Trigger 1 — post-create enrichment enqueue", () => {
  it("enqueues a postcreate job when a NEW vendor has a website (dryRun defaults true)", async () => {
    const eid = seedEvent();
    const { srv, sent } = makeServerWithQueue();
    const { payload } = await invokeOn(srv, {
      event_id: eid,
      business_name: "Fresh Site Vendor",
      website: "https://freshsite.example.com",
    });
    expect(payload?.was_created).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].vendorId).toBe(payload!.vendor_id);
    expect(sent[0].jobRunId).toBe(`postcreate-${payload!.vendor_id}`);
    expect(sent[0].dryRun).toBe(true);
  });

  it("does NOT enqueue when an existing vendor is matched (was_created=false)", async () => {
    const eid = seedEvent();
    seedVendor({
      id: "existing",
      businessName: "Matched Vendor",
      slug: "matched-vendor",
      website: "https://matched.example.com",
    });
    const { srv, sent } = makeServerWithQueue();
    const { payload } = await invokeOn(srv, {
      event_id: eid,
      business_name: "Matched Vendor",
      dedup_strategy: "strict",
      website: "https://matched.example.com",
    });
    expect(payload?.was_created).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("does NOT enqueue when the new vendor has no website", async () => {
    const eid = seedEvent();
    const { srv, sent } = makeServerWithQueue();
    const { payload } = await invokeOn(srv, {
      event_id: eid,
      business_name: "No Website Vendor",
    });
    expect(payload?.was_created).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("does NOT enqueue when website is whitespace-only", async () => {
    const eid = seedEvent();
    const { srv, sent } = makeServerWithQueue();
    const { payload } = await invokeOn(srv, {
      event_id: eid,
      business_name: "Blank Website Vendor",
      website: "   ",
    });
    expect(payload?.was_created).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("propagates dryRun=false when ENRICHMENT_DRY_RUN is 'false'", async () => {
    const eid = seedEvent();
    const { srv, sent } = makeServerWithQueue({ dryRunVar: "false" });
    await invokeOn(srv, {
      event_id: eid,
      business_name: "Live Merge Vendor",
      website: "https://livemerge.example.com",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].dryRun).toBe(false);
  });

  it("a queue send failure does NOT fail the create (best-effort)", async () => {
    const eid = seedEvent();
    const { srv } = makeServerWithQueue({ throwOnSend: true });
    const { isError, payload } = await invokeOn(srv, {
      event_id: eid,
      business_name: "Resilient Vendor",
      website: "https://resilient.example.com",
    });
    expect(isError).toBe(false);
    expect(payload?.was_created).toBe(true);
    expect(payload?.was_linked).toBe(true);
    // Vendor + link still persisted despite the queue throwing.
    const v = db.select().from(vendors).where(eq(vendors.id, payload!.vendor_id)).all();
    expect(v).toHaveLength(1);
  });
});
