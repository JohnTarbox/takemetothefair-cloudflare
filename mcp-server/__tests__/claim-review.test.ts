/**
 * OPE-67 — list_claims / approve_claim / reject_claim.
 *
 * Mirrors the OPE-65 admin-review security semantics (reimplemented in the MCP
 * runtime). Exercises: list filtering + decoration, vendor + promoter approve
 * happy paths (entity_claims → APPROVED, ownership transferred, role granted),
 * no-silent-takeover refusal, not_reviewable guard, and reject (REJECTED +
 * audit reason, ownership untouched).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerClaimReviewTools } from "../src/tools/admin-claim-review.js";
import { vendors, promoters, users, userRoles, entityClaims, adminActions } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "sekret" };

/**
 * OPE-792 — approve_claim / reject_claim now forward to the main app's
 * /api/admin/claims rather than transitioning the claim here. Capture the
 * forwarded request so the tests can assert on it.
 */
type FetchCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: FetchCall[] = [];
let originalFetch: typeof globalThis.fetch;
function stubFetch(response: Record<string, unknown>, status = 200) {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
}

let db: TestDb;
let server: CapturingMcpServer;

function seedUser(id: string) {
  db.insert(users)
    .values({ id, email: `${id}@test`, role: "USER" })
    .run();
  return id;
}

function seedVendor(over: Partial<typeof vendors.$inferInsert> = {}) {
  const id = over.id ?? "v-1";
  db.insert(vendors)
    .values({
      id,
      userId: over.userId ?? `owner-${id}`,
      businessName: over.businessName ?? "Acme Crafts",
      slug: over.slug ?? "acme-crafts",
      claimed: over.claimed ?? false,
      ...over,
    })
    .run();
  return id;
}

function seedPromoter(over: Partial<typeof promoters.$inferInsert> = {}) {
  const id = over.id ?? "p-1";
  db.insert(promoters)
    .values({
      id,
      companyName: over.companyName ?? "Fair Org",
      slug: over.slug ?? "fair-org",
      claimed: over.claimed ?? false,
      ...over,
    })
    .run();
  return id;
}

function seedClaim(over: Partial<typeof entityClaims.$inferInsert> = {}) {
  const id = over.id ?? "c-1";
  db.insert(entityClaims)
    .values({
      id,
      entityType: over.entityType ?? "VENDOR",
      entityId: over.entityId ?? "v-1",
      userId: over.userId ?? "claimant",
      method: over.method ?? "EVIDENCE",
      status: over.status ?? "PENDING",
      createdAt: over.createdAt ?? new Date(),
      ...over,
    })
    .run();
  return id;
}

async function invoke(name: string, params: Record<string, unknown>) {
  const res = (await server.invoke(name, params)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { res, json: JSON.parse(res.content[0].text) as Record<string, unknown> };
}

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerClaimReviewTools(server as never, db, ADMIN_AUTH, ENV);
  calls = [];
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("list_claims", () => {
  it("filters by status + entity_type and decorates rows", async () => {
    seedUser("claimant");
    seedVendor({ id: "v-1", slug: "acme-crafts", businessName: "Acme Crafts" });
    seedPromoter({ id: "p-1" });
    seedClaim({ id: "c-1", entityType: "VENDOR", entityId: "v-1", status: "PENDING" });
    seedClaim({ id: "c-2", entityType: "PROMOTER", entityId: "p-1", status: "APPROVED" });

    const all = await invoke("list_claims", {});
    expect(all.json.count).toBe(2);
    expect(all.json.truncated).toBe(false);

    const pendingVendors = await invoke("list_claims", {
      status: "PENDING",
      entity_type: "VENDOR",
    });
    const claims = pendingVendors.json.claims as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe("c-1");
    expect(claims[0].entity_name).toBe("Acme Crafts");
    expect(claims[0].entity_slug).toBe("acme-crafts");
    expect(claims[0].claimant_email).toBe("claimant@test");
  });
});

/**
 * OPE-792 — these two tools used to re-implement the whole transition here:
 * ownership transfer, role grant, status flip, audit row. That copy skipped the
 * two steps only `src/lib/claims/admin-review.ts` performs — the claimant
 * notification row and the decision email — so a claim approved through an
 * agent session moved ownership correctly and told the claimant nothing.
 *
 * The transition semantics (no-silent-takeover, not_reviewable, not_found,
 * reject-with-reason) are NOT retested here. They moved to where the code now
 * lives, and `src/lib/claims/__tests__/admin-review.test.ts` already covers each
 * one 1:1 — retesting them against a stubbed fetch would assert the stub.
 *
 * What is worth pinning here is what this file can uniquely break: that the
 * tools forward instead of writing, and that they write NOTHING to D1 themselves.
 */
describe("approve_claim / reject_claim — delegate to the single implementation (OPE-792)", () => {
  it("forwards an approval to /api/admin/claims over X-Internal-Key", async () => {
    stubFetch({
      ok: true,
      entityType: "VENDOR",
      entitySlug: "acme-crafts",
      entityName: "Acme Crafts",
      claimantUserId: "claimant",
      claimantEmail: "claimant@test",
    });
    const { json } = await invoke("approve_claim", { claim_id: "c-1", reason: "verified" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://app.test/api/admin/claims");
    expect(calls[0].headers["x-internal-key"]).toBe("sekret");
    expect(calls[0].body).toMatchObject({
      claimId: "c-1",
      action: "approve",
      reason: "verified",
      // No session on this path, so the audit row would otherwise be attributed
      // to "internal" rather than to the agent that made the decision.
      actorUserId: "u-admin",
    });
    expect(json.ok).toBe(true);
    expect(json.grantedTo).toBe("claimant");
    // The point of the ticket: the caller can SEE that the claimant was told.
    expect(json.claimantNotified).toBe("claimant@test");
  });

  it("forwards a rejection with its reason", async () => {
    stubFetch({
      ok: true,
      entityType: "VENDOR",
      entitySlug: "acme-crafts",
      entityName: "Acme Crafts",
      claimantUserId: "claimant",
      claimantEmail: "claimant@test",
      rejectReason: "not the owner",
    });
    const { json } = await invoke("reject_claim", { claim_id: "c-1", reason: "not the owner" });
    expect(calls[0].body).toMatchObject({ action: "reject", reason: "not the owner" });
    expect(json.ok).toBe(true);
    expect(json.claimantNotified).toBe("claimant@test");
  });

  it("reports claimantNotified:null when the core had no address — not the same as 'sent'", async () => {
    stubFetch({ ok: true, entityType: "VENDOR", claimantUserId: "claimant", claimantEmail: null });
    const { json } = await invoke("approve_claim", { claim_id: "c-1" });
    expect(json.claimantNotified).toBeNull();
  });

  it("surfaces the core's refusal instead of deciding for itself", async () => {
    stubFetch({ error: "already_claimed_by_other" }, 409);
    const { res, json } = await invoke("approve_claim", { claim_id: "c-1" });
    expect(res.isError).toBe(true);
    expect(json.http_status).toBe(409);
    expect(json.error).toBe("already_claimed_by_other");
  });

  it("writes NOTHING to D1 itself — the transition belongs to one implementation", async () => {
    // The regression that made OPE-792 possible: a local write here bypasses the
    // notification row and the decision email, silently and successfully.
    seedUser("claimant");
    seedVendor({ claimed: false });
    seedClaim({ status: "PENDING" });
    stubFetch({ ok: true, entityType: "VENDOR", claimantUserId: "claimant", claimantEmail: "c@t" });

    await invoke("approve_claim", { claim_id: "c-1" });

    const claim = db.select().from(entityClaims).where(eq(entityClaims.id, "c-1")).all()[0];
    expect(claim.status).toBe("PENDING"); // untouched locally
    const vendor = db.select().from(vendors).where(eq(vendors.id, "v-1")).all()[0];
    expect(vendor.claimed).toBe(false);
    expect(db.select().from(adminActions).all()).toHaveLength(0);
    expect(db.select().from(userRoles).all()).toHaveLength(0);
  });

  it("refuses when the forwarder is not configured, rather than failing open", async () => {
    const s2 = new CapturingMcpServer();
    registerClaimReviewTools(s2 as never, db, ADMIN_AUTH, {});
    const res = (await s2.invoke("approve_claim", { claim_id: "c-1" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).reason).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });
});
