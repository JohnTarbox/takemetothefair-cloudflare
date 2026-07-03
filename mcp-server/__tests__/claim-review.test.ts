/**
 * OPE-67 — list_claims / approve_claim / reject_claim.
 *
 * Mirrors the OPE-65 admin-review security semantics (reimplemented in the MCP
 * runtime). Exercises: list filtering + decoration, vendor + promoter approve
 * happy paths (entity_claims → APPROVED, ownership transferred, role granted),
 * no-silent-takeover refusal, not_reviewable guard, and reject (REJECTED +
 * audit reason, ownership untouched).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerClaimReviewTools } from "../src/tools/admin-claim-review.js";
import { vendors, promoters, users, userRoles, entityClaims, adminActions } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

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
  registerClaimReviewTools(server as never, db, ADMIN_AUTH);
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

describe("approve_claim", () => {
  it("vendor happy path: flips APPROVED, transfers ownership, grants role, audits", async () => {
    seedUser("claimant");
    seedVendor({ id: "v-1", userId: "placeholder", claimed: false });
    seedClaim({ id: "c-1", entityType: "VENDOR", entityId: "v-1", userId: "claimant" });

    const { json } = await invoke("approve_claim", { claim_id: "c-1", reason: "verified" });
    expect(json.ok).toBe(true);

    const [claim] = await db.select().from(entityClaims).where(eq(entityClaims.id, "c-1"));
    expect(claim.status).toBe("APPROVED");
    expect(claim.decidedBy).toBe("u-admin");
    expect(claim.decidedAt).not.toBeNull();

    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, "v-1"));
    expect(vendor.claimed).toBe(true);
    expect(vendor.userId).toBe("claimant");
    expect(vendor.claimedBy).toBe("claimant");

    const roles = await db.select().from(userRoles).where(eq(userRoles.userId, "claimant"));
    expect(roles.some((r) => r.role === "VENDOR")).toBe(true);

    const actions = await db.select().from(adminActions);
    expect(actions.some((a) => a.action === "vendor.claim_admin_review_approve")).toBe(true);
  });

  it("promoter happy path: flips APPROVED + transfers ownership + PROMOTER role", async () => {
    seedUser("claimant");
    seedPromoter({ id: "p-1", claimed: false });
    seedClaim({ id: "c-1", entityType: "PROMOTER", entityId: "p-1", userId: "claimant" });

    const { json } = await invoke("approve_claim", { claim_id: "c-1" });
    expect(json.ok).toBe(true);

    const [claim] = await db.select().from(entityClaims).where(eq(entityClaims.id, "c-1"));
    expect(claim.status).toBe("APPROVED");
    const [promoter] = await db.select().from(promoters).where(eq(promoters.id, "p-1"));
    expect(promoter.claimed).toBe(true);
    expect(promoter.userId).toBe("claimant");
    const roles = await db.select().from(userRoles).where(eq(userRoles.userId, "claimant"));
    expect(roles.some((r) => r.role === "PROMOTER")).toBe(true);
  });

  it("refuses already_claimed_by_other and touches nothing", async () => {
    seedUser("claimant");
    seedVendor({ id: "v-1", userId: "someone-else", claimed: true });
    seedClaim({ id: "c-1", entityType: "VENDOR", entityId: "v-1", userId: "claimant" });

    const { res, json } = await invoke("approve_claim", { claim_id: "c-1" });
    expect(res.isError).toBe(true);
    expect(json.reason).toBe("already_claimed_by_other");

    const [claim] = await db.select().from(entityClaims).where(eq(entityClaims.id, "c-1"));
    expect(claim.status).toBe("PENDING"); // untouched
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, "v-1"));
    expect(vendor.userId).toBe("someone-else"); // untouched
  });

  it("not_reviewable when the claim is not PENDING/DISPUTED", async () => {
    seedUser("claimant");
    seedVendor({ id: "v-1" });
    seedClaim({ id: "c-1", entityType: "VENDOR", entityId: "v-1", status: "APPROVED" });

    const { res, json } = await invoke("approve_claim", { claim_id: "c-1" });
    expect(res.isError).toBe(true);
    expect(json.reason).toBe("not_reviewable");
  });

  it("not_found for an unknown claim id", async () => {
    const { res, json } = await invoke("approve_claim", { claim_id: "nope" });
    expect(res.isError).toBe(true);
    expect(json.reason).toBe("not_found");
  });
});

describe("reject_claim", () => {
  it("marks REJECTED with the reason in audit, ownership untouched", async () => {
    seedUser("claimant");
    seedVendor({ id: "v-1", userId: "placeholder", claimed: false });
    seedClaim({ id: "c-1", entityType: "VENDOR", entityId: "v-1", userId: "claimant" });

    const { json } = await invoke("reject_claim", { claim_id: "c-1", reason: "not the owner" });
    expect(json.ok).toBe(true);
    expect(json.rejectReason).toBe("not the owner");

    const [claim] = await db.select().from(entityClaims).where(eq(entityClaims.id, "c-1"));
    expect(claim.status).toBe("REJECTED");
    expect(claim.decidedBy).toBe("u-admin");

    // Ownership untouched.
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, "v-1"));
    expect(vendor.claimed).toBe(false);
    expect(vendor.userId).toBe("placeholder");

    const actions = await db.select().from(adminActions);
    const reject = actions.find((a) => a.action === "vendor.claim_admin_review_reject");
    expect(reject).toBeDefined();
    expect(JSON.parse(reject!.payloadJson!).reason).toBe("not the owner");
  });

  it("not_reviewable for an already-decided claim", async () => {
    seedVendor({ id: "v-1" });
    seedClaim({ id: "c-1", entityType: "VENDOR", entityId: "v-1", status: "REJECTED" });
    const { res, json } = await invoke("reject_claim", { claim_id: "c-1", reason: "dup" });
    expect(res.isError).toBe(true);
    expect(json.reason).toBe("not_reviewable");
  });
});
