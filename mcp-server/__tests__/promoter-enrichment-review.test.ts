/**
 * OPE-36 promoter pre-extraction review tools —
 * list_promoter_enrichment_candidates + review_promoter_enrichment_candidate.
 * Mirrors enrichment-review.test.ts (the vendor surface).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { promoters, promoterEnrichmentCandidates, pendingSearchPings } from "../src/schema.js";

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

function seedPromoter(overrides: Partial<typeof promoters.$inferInsert> = {}) {
  const id = overrides.id ?? "promoter-1";
  db.insert(promoters)
    .values({
      id,
      companyName: overrides.companyName ?? "Test Promoter",
      slug: overrides.slug ?? `slug-${id}`,
      ...overrides,
    })
    .run();
  return id;
}

function seedCandidate(overrides: Partial<typeof promoterEnrichmentCandidates.$inferInsert> = {}) {
  const [row] = db
    .insert(promoterEnrichmentCandidates)
    .values({
      promoterId: overrides.promoterId ?? "promoter-1",
      jobRunId: overrides.jobRunId ?? "manual-test",
      proposedField: overrides.proposedField ?? "contact_phone",
      currentValue: overrides.currentValue ?? null,
      proposedValue: overrides.proposedValue ?? "207-555-1212",
      sourceUrl: overrides.sourceUrl ?? "https://promoter.example.com",
      extractionMethod: overrides.extractionMethod ?? "tel",
      fetchMethod: overrides.fetchMethod ?? "standard",
      confidence: overrides.confidence ?? 0.8,
      flags: overrides.flags ?? "[]",
      createdAt: overrides.createdAt ?? new Date(),
      decision: overrides.decision ?? "pending",
    })
    .returning({ id: promoterEnrichmentCandidates.id })
    .all();
  return row.id;
}

type ListPayload = {
  count: number;
  summary: { by_decision: Record<string, number>; pending_clean: number; pending_flagged: number };
  candidates: Array<{
    id: number;
    promoter_id: string;
    company_name: string | null;
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
  applied?: boolean;
  decision?: string;
  reason?: string;
  applied_value?: string;
  current_value?: string | null;
};

async function list(args: Record<string, unknown> = {}) {
  const r = (await server.invoke("list_promoter_enrichment_candidates", args)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(r.content[0].text) as ListPayload;
}

async function review(args: Record<string, unknown>) {
  const r = (await server.invoke("review_promoter_enrichment_candidate", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { isError: !!r.isError, payload: JSON.parse(r.content[0].text) as ReviewPayload };
}

describe("list_promoter_enrichment_candidates", () => {
  it("returns pending candidates by default with company name joined", async () => {
    seedPromoter({ id: "p1", companyName: "Joined Promoter", slug: "joined" });
    seedCandidate({ promoterId: "p1", proposedField: "hero", proposedValue: "https://x/h.png" });
    const res = await list();
    expect(res.count).toBe(1);
    expect(res.candidates[0].company_name).toBe("Joined Promoter");
    expect(res.candidates[0].field).toBe("hero");
    expect(res.candidates[0].decision).toBe("pending");
  });

  it("excludes non-pending rows under the default filter, but summary spans all", async () => {
    seedPromoter();
    seedCandidate({ decision: "pending" });
    seedCandidate({ decision: "rejected", proposedField: "contact_email" });
    seedCandidate({ decision: "auto_merged", proposedField: "social_links" });
    const res = await list();
    expect(res.count).toBe(1);
    expect(res.summary.by_decision.pending).toBe(1);
    expect(res.summary.by_decision.rejected).toBe(1);
    expect(res.summary.by_decision.auto_merged).toBe(1);
  });

  it("flagged:'only'/'clean' split the pending queue", async () => {
    seedPromoter();
    seedCandidate({ flags: "[]", proposedField: "contact_phone" });
    seedCandidate({ flags: '["domain_mismatch"]', proposedField: "social_links" });
    const onlyClean = await list({ flagged: "clean" });
    expect(onlyClean.count).toBe(1);
    expect(onlyClean.summary.pending_clean).toBe(1);
    expect(onlyClean.summary.pending_flagged).toBe(1);
  });
});

describe("review_promoter_enrichment_candidate — approve", () => {
  it("applies a clean fill into an empty field, recomputes, defers an IndexNow ping", async () => {
    seedPromoter({ id: "p1", slug: "fillme", contactPhone: null });
    const id = seedCandidate({
      promoterId: "p1",
      proposedField: "contact_phone",
      proposedValue: "207-555-9000",
    });

    const { isError, payload } = await review({ candidate_id: id, action: "approve" });
    expect(isError).toBe(false);
    expect(payload.applied).toBe(true);
    expect(payload.decision).toBe("approved");
    expect(payload.applied_value).toBe("207-555-9000");

    const [p] = db.select().from(promoters).where(eq(promoters.id, "p1")).all();
    expect(p.contactPhone).toBe("207-555-9000");
    // enrichment recomputed (has website? no → but contact now covered).
    expect(p.lastEnrichedAt).not.toBeNull();
    // Deferred to the outbox, not fired inline.
    expect(mock.calls).toHaveLength(0);
    const pending = db
      .select()
      .from(pendingSearchPings)
      .where(eq(pendingSearchPings.entityId, "p1"))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0].entityType).toBe("promoter");
  });

  it("applies a hero fill (promoter-specific field)", async () => {
    seedPromoter({ id: "p1", slug: "hero", heroImageUrl: null });
    const id = seedCandidate({
      promoterId: "p1",
      proposedField: "hero",
      proposedValue: "https://cdn/hero.png",
      extractionMethod: "og-image",
    });
    const { payload } = await review({ candidate_id: id, action: "approve" });
    expect(payload.applied).toBe(true);
    const [p] = db.select().from(promoters).where(eq(promoters.id, "p1")).all();
    expect(p.heroImageUrl).toBe("https://cdn/hero.png");
  });

  it("treats a placeholder description as empty and fills it", async () => {
    seedPromoter({ id: "p1", slug: "desc", description: "Event organizer." });
    const id = seedCandidate({
      promoterId: "p1",
      proposedField: "description",
      proposedValue: "Acme runs Maine's biggest craft fairs since 1998.",
      extractionMethod: "regex",
    });
    const { payload } = await review({ candidate_id: id, action: "approve" });
    expect(payload.applied).toBe(true);
    const [p] = db.select().from(promoters).where(eq(promoters.id, "p1")).all();
    expect(p.description).toContain("Acme");
  });

  it("does NOT clobber a field populated since staging (fill-empty-only)", async () => {
    seedPromoter({ id: "p1", slug: "taken", contactEmail: "already@there.com" });
    const id = seedCandidate({
      promoterId: "p1",
      proposedField: "contact_email",
      proposedValue: "new@proposed.com",
      extractionMethod: "mailto",
    });
    const { payload } = await review({ candidate_id: id, action: "approve" });
    expect(payload.applied).toBe(false);
    expect(payload.reason).toBe("field_already_populated");
    expect(payload.decision).toBe("approved");
    const [p] = db.select().from(promoters).where(eq(promoters.id, "p1")).all();
    expect(p.contactEmail).toBe("already@there.com");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("review_promoter_enrichment_candidate — reject + guards", () => {
  it("marks rejected without touching the promoter or pinging", async () => {
    seedPromoter({ id: "p1", slug: "rej", contactPhone: null });
    const id = seedCandidate({ promoterId: "p1", proposedValue: "207-555-0000" });
    const { payload } = await review({ candidate_id: id, action: "reject" });
    expect(payload.applied).toBe(false);
    expect(payload.decision).toBe("rejected");
    const [p] = db.select().from(promoters).where(eq(promoters.id, "p1")).all();
    expect(p.contactPhone).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it("errors on a non-existent candidate", async () => {
    const { isError, payload } = await review({ candidate_id: 999999, action: "approve" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("candidate_not_found");
  });

  it("errors when the candidate was already reviewed", async () => {
    seedPromoter({ id: "p1", slug: "done" });
    const id = seedCandidate({ promoterId: "p1", decision: "approved" });
    const { isError, payload } = await review({ candidate_id: id, action: "approve" });
    expect(isError).toBe(true);
    expect(payload.error).toBe("already_reviewed");
  });
});
