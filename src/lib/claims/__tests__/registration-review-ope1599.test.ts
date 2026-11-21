/**
 * OPE-1599 — resolving a registration realness row, and the "missing claim row"
 * figure. Real SQLite, real route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";
import { getClaimEstate } from "../claim-estate";

let sqlite: Database.Database;

vi.mock("@/lib/api-auth", () => ({
  getAuthorizedSession: async () => ({ authorized: true, userId: "admin-1" }),
}));
vi.mock("@/lib/logger", () => ({ logError: async () => undefined }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => drizzle(sqlite, { schema }) }));

const { POST } = await import("@/app/api/admin/claims/registration/route");

function typeless(table: Parameters<typeof getTableConfig>[0]): string {
  const { name, columns } = getTableConfig(table);
  return `CREATE TABLE ${name} (${columns.map((c) => `"${c.name}"`).join(", ")});`;
}

const NOW = Math.floor(Date.now() / 1000);

function vendor(id: string, o: { deleted?: boolean; claimedAt?: number; createdAt?: number } = {}) {
  sqlite
    .prepare(
      `INSERT INTO vendors (id, business_name, slug, user_id, claimed, claimed_at, claimed_by, created_at, deleted_at)
       VALUES (?, ?, ?, 'u1', 1, ?, 'u1', ?, ?)`
    )
    .run(id, `Biz ${id}`, id, o.claimedAt ?? NOW, o.createdAt ?? NOW, o.deleted ? NOW : null);
}
function evidence(vendorId: string) {
  sqlite
    .prepare(
      `INSERT INTO vendor_claim_evidence (id, vendor_id, business_name, created_at) VALUES (?, ?, 'x', 1)`
    )
    .run(`e-${vendorId}`, vendorId);
}
const decide = (vendorId: string, decision: string) =>
  POST(
    new Request("http://localhost/api/admin/claims/registration", {
      method: "POST",
      body: JSON.stringify({ vendorId, decision }),
    }) as never,
    { params: Promise.resolve({}) } as never
  );
const stored = (vendorId: string) =>
  sqlite
    .prepare(
      "SELECT review_decision d, reviewed_at r FROM vendor_claim_evidence WHERE vendor_id = ?"
    )
    .get(vendorId) as { d: string | null; r: number | null };

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(
    [
      schema.vendors,
      schema.vendorClaimEvidence,
      schema.adminActions,
      schema.entityClaims,
      schema.users,
      schema.promoters,
    ]
      .map(typeless)
      .join("\n")
  );
});

describe("registration review decisions", () => {
  it("Looks real records the decision and an audit row", async () => {
    vendor("v1");
    evidence("v1");
    expect((await decide("v1", "LOOKS_REAL")).status).toBe(200);
    expect(stored("v1").d).toBe("LOOKS_REAL");
    expect(sqlite.prepare("SELECT action, target_id t FROM admin_actions").all()).toEqual([
      { action: "vendor.registration_review", t: "v1" },
    ]);
  });

  it("REFUSES to record a suspension on a listing that is still live", async () => {
    vendor("v1");
    evidence("v1");
    const res = await decide("v1", "SUSPENDED");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "listing_still_live" });
    expect(stored("v1")).toEqual({ d: null, r: null });
  });

  it("records a suspension once the soft delete has happened", async () => {
    vendor("v1", { deleted: true });
    evidence("v1");
    expect((await decide("v1", "SPAM")).status).toBe(200);
    expect(stored("v1").d).toBe("SPAM");
  });

  it("an unknown decision is a 400 and writes nothing", async () => {
    vendor("v1");
    evidence("v1");
    expect((await decide("v1", "DELETE_IT")).status).toBe(400);
    expect(stored("v1").r).toBeNull();
  });
});

describe("Missing claim row (last 30d)", () => {
  it("does not count a signup: created and claimed in one write by its own user", async () => {
    vendor("signup", { claimedAt: NOW, createdAt: NOW });
    const estate = await getClaimEstate(drizzle(sqlite, { schema }) as never);
    expect(estate.divergentRecent).toBe(0);
    expect(estate.divergent).toBe(1);
  });

  it("DOES count a listing that existed before it was claimed with no claim row", async () => {
    vendor("bypass", { claimedAt: NOW, createdAt: NOW - 86_400 });
    const estate = await getClaimEstate(drizzle(sqlite, { schema }) as never);
    expect(estate.divergentRecent).toBe(1);
  });

  it("does not count that listing once it has a claim row", async () => {
    vendor("ok", { claimedAt: NOW, createdAt: NOW - 86_400 });
    sqlite
      .prepare(
        "INSERT INTO entity_claims (id, entity_type, entity_id, user_id) VALUES ('c','VENDOR','ok','u1')"
      )
      .run();
    const estate = await getClaimEstate(drizzle(sqlite, { schema }) as never);
    expect(estate.divergentRecent).toBe(0);
  });
});
