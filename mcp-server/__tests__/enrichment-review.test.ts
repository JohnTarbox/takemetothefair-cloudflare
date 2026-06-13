/**
 * Unit tests for the I1 enrichment review tools (list_enrichment_candidates +
 * review_enrichment_candidate). Same in-memory SQLite + CapturingMcpServer +
 * mockIndexNowFetch harness as create-or-link-vendor.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { users, vendors, vendorEnrichmentCandidates, pendingSearchPings } from "../src/schema.js";

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

function seedVendor(overrides: Partial<typeof vendors.$inferInsert> = {}) {
  const id = overrides.id ?? "vendor-1";
  const userId = overrides.userId ?? `u-${id}`;
  db.insert(users)
    .values({ id: userId, email: `${userId}@test`, role: "VENDOR" })
    .run();
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

function seedCandidate(overrides: Partial<typeof vendorEnrichmentCandidates.$inferInsert> = {}) {
  const [row] = db
    .insert(vendorEnrichmentCandidates)
    .values({
      vendorId: overrides.vendorId ?? "vendor-1",
      jobRunId: overrides.jobRunId ?? "manual-test",
      proposedField: overrides.proposedField ?? "contact_phone",
      currentValue: overrides.currentValue ?? null,
      proposedValue: overrides.proposedValue ?? "207-555-1212",
      sourceUrl: overrides.sourceUrl ?? "https://vendor.example.com",
      extractionMethod: overrides.extractionMethod ?? "regex",
      fetchMethod: overrides.fetchMethod ?? "standard",
      confidence: overrides.confidence ?? 0.5,
      flags: overrides.flags ?? "[]",
      createdAt: overrides.createdAt ?? new Date(),
      decision: overrides.decision ?? "pending",
    })
    .returning({ id: vendorEnrichmentCandidates.id })
    .all();
  return row.id;
}

type ListPayload = {
  count: number;
  summary: { by_decision: Record<string, number>; pending_clean: number; pending_flagged: number };
  candidates: Array<{
    id: number;
    vendor_id: string;
    business_name: string | null;
    field: string;
    proposed_value: string;
    confidence: number;
    flags: string[];
    decision: string;
  }>;
};

type ReviewPayload = {
  success?: boolean;
  error?: string;
  candidate_id?: number;
  field?: string;
  action?: string;
  applied?: boolean;
  decision?: string;
  reason?: string;
  applied_value?: string;
  current_value?: string | null;
};

async function list(args: Record<string, unknown> = {}) {
  const r = (await server.invoke("list_enrichment_candidates", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return JSON.parse(r.content[0].text) as ListPayload;
}

async function review(args: Record<string, unknown>) {
  const r = (await server.invoke("review_enrichment_candidate", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { isError: !!r.isError, payload: JSON.parse(r.content[0].text) as ReviewPayload };
}

// list_enrichment_candidates -----------------------------------------------

describe("list_enrichment_candidates", () => {
  it("returns pending candidates by default with vendor business name joined", async () => {
    seedVendor({ id: "v1", businessName: "Joined Vendor", slug: "joined" });
    seedCandidate({ vendorId: "v1", proposedField: "contact_email", proposedValue: "a@v.com" });
    const res = await list();
    expect(res.count).toBe(1);
    expect(res.candidates[0].business_name).toBe("Joined Vendor");
    expect(res.candidates[0].field).toBe("contact_email");
    expect(res.candidates[0].decision).toBe("pending");
  });

  it("excludes non-pending rows under the default filter", async () => {
    seedVendor();
    seedCandidate({ decision: "pending" });
    seedCandidate({ decision: "rejected", proposedField: "contact_email" });
    seedCandidate({ decision: "auto_merged", proposedField: "address" });
    const res = await list();
    expect(res.count).toBe(1);
    // Summary spans ALL decisions regardless of the active filter.
    expect(res.summary.by_decision.pending).toBe(1);
    expect(res.summary.by_decision.rejected).toBe(1);
    expect(res.summary.by_decision.auto_merged).toBe(1);
  });

  it("flagged:'only' and flagged:'clean' split the queue", async () => {
    seedVendor();
    seedCandidate({ flags: "[]", proposedField: "contact_phone" });
    seedCandidate({ flags: '["social_name_mismatch"]', proposedField: "social_links" });
    const onlyFlagged = await list({ flagged: "only" });
    expect(onlyFlagged.count).toBe(1);
    expect(onlyFlagged.candidates[0].flags).toEqual(["social_name_mismatch"]);
    const onlyClean = await list({ flagged: "clean" });
    expect(onlyClean.count).toBe(1);
    expect(onlyClean.candidates[0].flags).toEqual([]);
    // Pending split summary reflects both.
    expect(onlyClean.summary.pending_clean).toBe(1);
    expect(onlyClean.summary.pending_flagged).toBe(1);
  });

  it("filters by min_confidence, vendor_id, and field", async () => {
    seedVendor({ id: "vA", slug: "va" });
    seedVendor({ id: "vB", slug: "vb" });
    seedCandidate({ vendorId: "vA", confidence: 0.9, proposedField: "contact_phone" });
    seedCandidate({ vendorId: "vA", confidence: 0.4, proposedField: "contact_email" });
    seedCandidate({ vendorId: "vB", confidence: 0.95, proposedField: "contact_phone" });

    expect((await list({ min_confidence: 0.85 })).count).toBe(2);
    expect((await list({ vendor_id: "vA" })).count).toBe(2);
    expect((await list({ field: "contact_phone" })).count).toBe(2);
    expect((await list({ vendor_id: "vA", field: "contact_phone" })).count).toBe(1);
  });
});

// review_enrichment_candidate ----------------------------------------------

describe("review_enrichment_candidate — approve", () => {
  it("applies a clean fill into an empty field and enqueues a deferred IndexNow ping", async () => {
    seedVendor({ id: "v1", slug: "fillme", contactPhone: null });
    const id = seedCandidate({
      vendorId: "v1",
      proposedField: "contact_phone",
      proposedValue: "207-555-9000",
    });

    const { isError, payload } = await review({ candidate_id: id, action: "approve" });
    expect(isError).toBe(false);
    expect(payload.applied).toBe(true);
    expect(payload.decision).toBe("approved");
    expect(payload.applied_value).toBe("207-555-9000");

    const [v] = db.select().from(vendors).where(eq(vendors.id, "v1")).all();
    expect(v.contactPhone).toBe("207-555-9000");
    const [c] = db
      .select()
      .from(vendorEnrichmentCandidates)
      .where(eq(vendorEnrichmentCandidates.id, id))
      .all();
    expect(c.decision).toBe("approved");
    expect(c.reviewedBy).toBe("u-admin");
    // REL4 (2026-06-13) — the ping is deferred to the outbox (batched + drained
    // by flush/cron) instead of fired inline, so the review sweep can't trip
    // Bing's per-host rate limit. No inline call; one pending row for the vendor.
    expect(mock.calls).toHaveLength(0);
    const pending = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.entityId, "v1"))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0].entityType).toBe("vendor");
  });

  it("allows a human to approve a FLAGGED candidate (manual override)", async () => {
    seedVendor({ id: "v1", slug: "flagged", socialLinks: null });
    const id = seedCandidate({
      vendorId: "v1",
      proposedField: "social_links",
      proposedValue: '{"facebook":"https://facebook.com/x"}',
      flags: '["social_name_mismatch"]',
    });
    const { payload } = await review({ candidate_id: id, action: "approve" });
    expect(payload.applied).toBe(true);
    const [v] = db.select().from(vendors).where(eq(vendors.id, "v1")).all();
    expect(v.socialLinks).toBe('{"facebook":"https://facebook.com/x"}');
  });

  it("does NOT clobber a field populated since staging (fill-empty-only)", async () => {
    seedVendor({ id: "v1", slug: "taken", contactEmail: "already@there.com" });
    const id = seedCandidate({
      vendorId: "v1",
      proposedField: "contact_email",
      proposedValue: "new@proposed.com",
    });
    const { payload } = await review({ candidate_id: id, action: "approve" });
    expect(payload.applied).toBe(false);
    expect(payload.reason).toBe("field_already_populated");
    expect(payload.decision).toBe("approved"); // still leaves the queue
    const [v] = db.select().from(vendors).where(eq(vendors.id, "v1")).all();
    expect(v.contactEmail).toBe("already@there.com"); // unchanged
    expect(mock.calls).toHaveLength(0); // no ping when nothing applied
  });

  it("treats '{}' social_links as empty and fills it", async () => {
    seedVendor({ id: "v1", slug: "emptyjson", socialLinks: "{}" });
    const id = seedCandidate({
      vendorId: "v1",
      proposedField: "social_links",
      proposedValue: '{"instagram":"https://instagram.com/x"}',
    });
    const { payload } = await review({ candidate_id: id, action: "approve" });
    expect(payload.applied).toBe(true);
  });

  it("rejects approving a non-applicable field (description)", async () => {
    seedVendor({ id: "v1", slug: "desc" });
    const id = seedCandidate({
      vendorId: "v1",
      proposedField: "description",
      proposedValue: "blah",
    });
    const { isError, payload } = await review({ candidate_id: id, action: "approve" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("field_not_applicable");
  });
});

describe("review_enrichment_candidate — reject", () => {
  it("marks rejected without touching the vendor or pinging", async () => {
    seedVendor({ id: "v1", slug: "rej", contactPhone: null });
    const id = seedCandidate({
      vendorId: "v1",
      proposedField: "contact_phone",
      proposedValue: "207-555-0000",
    });
    const { payload } = await review({ candidate_id: id, action: "reject" });
    expect(payload.applied).toBe(false);
    expect(payload.decision).toBe("rejected");
    const [v] = db.select().from(vendors).where(eq(vendors.id, "v1")).all();
    expect(v.contactPhone).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });
});

describe("review_enrichment_candidate — guards", () => {
  it("errors on a non-existent candidate", async () => {
    const { isError, payload } = await review({ candidate_id: 999999, action: "approve" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("candidate_not_found");
  });

  it("errors when the candidate was already reviewed", async () => {
    seedVendor({ id: "v1", slug: "done" });
    const id = seedCandidate({ vendorId: "v1", decision: "approved" });
    const { isError, payload } = await review({ candidate_id: id, action: "approve" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("already_reviewed");
    expect(payload.decision).toBe("approved");
  });

  it("errors when the vendor is soft-deleted", async () => {
    seedVendor({ id: "v1", slug: "gone", deletedAt: new Date() });
    const id = seedCandidate({ vendorId: "v1" });
    const { isError, payload } = await review({ candidate_id: id, action: "approve" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("vendor_not_found_or_deleted");
  });
});
