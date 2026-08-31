/**
 * OPE-236 §4 — `admin_approve_vendor_claim` writes the canonical claim row.
 *
 * The unit tests for `buildSettledEntityClaim` / `shouldRecordEntityClaim` pin
 * the RULE. They say nothing about whether this tool calls it, and that gap is
 * the whole defect: the tool has always set `vendors.claimed=1` correctly and
 * always skipped `entity_claims`, so a suite that only tested the rule would go
 * green on a tool that still writes nothing. These tests read the table back.
 *
 * The live specimen: `admin_approve_vendor_claim` claimed `21-street-beads` on
 * 2026-08-30 at 17:46:49 with no `entity_claims` row, while `approve_claim`
 * wrote one 34 minutes later — one admin tool skipping the canonical table on
 * the exact claim class this ticket is about.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminClaimApprovalTool } from "../src/tools/admin-claim-approval.js";
import { vendors, users, entityClaims } from "../src/schema.js";

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
      // vendors.user_id is NOT NULL — an unclaimed listing still carries the
      // placeholder account that ingestion created it under.
      userId: over.userId ?? `placeholder-${id}`,
      businessName: over.businessName ?? "Acme Crafts",
      slug: over.slug ?? "acme-crafts",
      claimed: over.claimed ?? false,
      ...over,
    })
    .run();
  return id;
}

function claimRows(entityId: string) {
  return db
    .select()
    .from(entityClaims)
    .where(and(eq(entityClaims.entityType, "VENDOR"), eq(entityClaims.entityId, entityId)))
    .all();
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
  registerAdminClaimApprovalTool(server as never, db, ADMIN_AUTH);
});

describe("admin_approve_vendor_claim → entity_claims", () => {
  it("writes exactly one APPROVED ADMIN claim row for a pre-existing listing", async () => {
    seedUser("claimant");
    seedVendor({ id: "v-1", claimed: false });

    // Nothing to begin with — this is the state that made every admin approval
    // invisible to /admin/claims and list_claims.
    expect(claimRows("v-1")).toHaveLength(0);

    const { json } = await invoke("admin_approve_vendor_claim", {
      vendor_id: "v-1",
      user_id: "claimant",
      reason: "verified ownership via business registration docs",
    });
    expect(json.ok).toBe(true);
    expect(json.claimRecorded).toBe(true);

    const rows = claimRows("v-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("claimant");
    expect(rows[0].method).toBe("ADMIN");
    expect(rows[0].status).toBe("APPROVED");
    // Credited to the admin who authorised it, not to the claimant.
    expect(rows[0].decidedBy).toBe("u-admin");
    expect(rows[0].decidedAt).not.toBeNull();
    // The approval reason is the out-of-band proof; losing it would leave an
    // ADMIN-method row with no record of what was actually verified.
    expect(rows[0].evidence).toContain("business registration docs");
  });

  it("does not duplicate the row when the same approval is re-run", async () => {
    seedUser("claimant");
    seedVendor({ id: "v-1", claimed: false });

    await invoke("admin_approve_vendor_claim", {
      vendor_id: "v-1",
      user_id: "claimant",
      reason: "first approval",
    });
    const second = await invoke("admin_approve_vendor_claim", {
      vendor_id: "v-1",
      user_id: "claimant",
      reason: "same approval, run twice",
    });

    expect(second.json.wasAlreadyClaimed).toBe(true);
    expect(second.json.claimRecorded).toBe(false);
    expect(claimRows("v-1")).toHaveLength(1);
  });

  it("REPAIRS a listing claimed by an earlier run that wrote no claim row", async () => {
    // The backlog case. A vendor already carries claimed=1 from a pre-fix run,
    // so `wasAlreadyClaimed` short-circuits the vendor mutation — and if the
    // claim write sat inside that branch, re-running the tool could never
    // repair the missing row. It must land on the already-claimed path too.
    seedUser("claimant");
    seedVendor({ id: "v-1", claimed: true, userId: "claimant", claimedBy: "claimant" });
    expect(claimRows("v-1")).toHaveLength(0);

    const { json } = await invoke("admin_approve_vendor_claim", {
      vendor_id: "v-1",
      user_id: "claimant",
      reason: "re-run to record the missing claim row",
    });

    expect(json.wasAlreadyClaimed).toBe(true);
    expect(json.claimRecorded).toBe(true);
    expect(claimRows("v-1")).toHaveLength(1);
  });

  it("writes no claim row when it refuses a cross-user takeover", async () => {
    // The refusal must be total. A claim row for a user the tool declined to
    // grant ownership to would put a fabricated claim in front of an admin.
    seedUser("claimant");
    seedUser("other");
    seedVendor({ id: "v-1", claimed: true, userId: "other" });

    const { res } = await invoke("admin_approve_vendor_claim", {
      vendor_id: "v-1",
      user_id: "claimant",
      reason: "attempted takeover",
    });

    expect(res.isError).toBe(true);
    expect(claimRows("v-1")).toHaveLength(0);
  });
});
