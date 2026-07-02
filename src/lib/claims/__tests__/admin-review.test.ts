/**
 * OPE-65 — admin claim-review core (approveClaim / rejectClaim /
 * listReviewableClaims) against better-sqlite3.
 *
 * Mirrors the resolve-claim-at-signup harness: an in-memory SQLite schema
 * bootstrap, direct helper calls, raw-SQL assertions. The decision email is
 * best-effort and swallows the missing-Cloudflare-env failure in this
 * environment, so no queue infra is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { approveClaim, rejectClaim, listReviewableClaims } from "../admin-review";

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    password_hash TEXT,
    email_verified INTEGER
  );
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    business_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    contact_email TEXT,
    claimed INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    claimed_by TEXT,
    deleted_at INTEGER
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    company_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    contact_email TEXT,
    claimed INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    claimed_by TEXT
  );
  CREATE TABLE user_roles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    granted_by TEXT
  );
  CREATE UNIQUE INDEX user_roles_user_role_unique ON user_roles (user_id, role);
  CREATE TABLE entity_claims (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    evidence TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ADMIN = "admin-1";
const CLAIMANT = "claimant-1";
const OTHER = "other-owner";

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  const insUser = raw.prepare(`INSERT INTO users (id, email, name) VALUES (?, ?, ?)`);
  insUser.run(ADMIN, "admin@example.com", "Admin");
  insUser.run(CLAIMANT, "claimant@business.com", "Claimant Person");
  insUser.run(OTHER, "other@business.com", "Other Owner");
});
afterEach(() => raw.close());

function seedVendor(opts: { id: string; slug: string; claimed?: boolean; ownerUserId?: string }) {
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, claimed, claimed_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.ownerUserId ?? "placeholder-user",
      "Acme Foods",
      opts.slug,
      opts.claimed ? 1 : 0,
      opts.claimed ? (opts.ownerUserId ?? null) : null
    );
}

function seedPromoter(opts: {
  id: string;
  slug: string;
  claimed?: boolean;
  ownerUserId?: string | null;
}) {
  raw
    .prepare(
      `INSERT INTO promoters (id, user_id, company_name, slug, claimed, claimed_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.ownerUserId ?? null,
      "Big Events Co",
      opts.slug,
      opts.claimed ? 1 : 0,
      opts.claimed ? (opts.ownerUserId ?? null) : null
    );
}

function seedClaim(opts: {
  id: string;
  entityType: "VENDOR" | "PROMOTER" | "VENUE";
  entityId: string;
  userId?: string;
  method?: string;
  status?: string;
  evidence?: string | null;
  createdAt?: number;
}) {
  raw
    .prepare(
      `INSERT INTO entity_claims (id, entity_type, entity_id, user_id, method, status, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.entityType,
      opts.entityId,
      opts.userId ?? CLAIMANT,
      opts.method ?? "EVIDENCE",
      opts.status ?? "PENDING",
      opts.evidence ?? null,
      opts.createdAt ?? Math.floor(Date.now() / 1000)
    );
}

function vendorRow(id: string) {
  return raw.prepare(`SELECT * FROM vendors WHERE id = ?`).get(id) as {
    user_id: string;
    claimed: number;
    claimed_by: string | null;
  };
}
function promoterRow(id: string) {
  return raw.prepare(`SELECT * FROM promoters WHERE id = ?`).get(id) as {
    user_id: string | null;
    claimed: number;
    claimed_by: string | null;
  };
}
function claimRow(id: string) {
  return raw.prepare(`SELECT * FROM entity_claims WHERE id = ?`).get(id) as {
    status: string;
    decided_by: string | null;
  };
}
function roleRows(userId: string) {
  return raw.prepare(`SELECT * FROM user_roles WHERE user_id = ?`).all(userId) as Array<{
    role: string;
    granted_by: string | null;
  }>;
}
function adminActionRows() {
  return raw.prepare(`SELECT * FROM admin_actions`).all() as Array<{
    action: string;
    actor_user_id: string | null;
    target_type: string;
    target_id: string;
    payload_json: string | null;
  }>;
}

describe("approveClaim", () => {
  it("approves a PENDING EVIDENCE vendor claim on an unclaimed vendor", async () => {
    seedVendor({ id: "v1", slug: "acme-foods" });
    seedClaim({ id: "c1", entityType: "VENDOR", entityId: "v1", method: "EVIDENCE" });

    const res = await approveClaim(db as never, { claimId: "c1", actorUserId: ADMIN });
    expect(res.ok).toBe(true);
    expect(res.entityType).toBe("VENDOR");
    expect(res.entitySlug).toBe("acme-foods");
    expect(res.claimantEmail).toBe("claimant@business.com");

    const v = vendorRow("v1");
    expect(v.claimed).toBe(1);
    expect(v.user_id).toBe(CLAIMANT);
    expect(v.claimed_by).toBe(CLAIMANT);

    expect(roleRows(CLAIMANT).map((r) => r.role)).toContain("VENDOR");
    expect(roleRows(CLAIMANT)[0].granted_by).toBe(ADMIN);

    expect(claimRow("c1")).toMatchObject({ status: "APPROVED", decided_by: ADMIN });

    const actions = adminActionRows();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: "vendor.claim_admin_review_approve",
      actor_user_id: ADMIN,
      target_type: "vendor",
      target_id: "v1",
    });
    expect(JSON.parse(actions[0].payload_json!)).toMatchObject({
      via: "admin/claims",
      claimId: "c1",
      method: "EVIDENCE",
    });
  });

  it("approves a promoter claim (parity)", async () => {
    seedPromoter({ id: "p1", slug: "big-events-co" });
    seedClaim({ id: "c1", entityType: "PROMOTER", entityId: "p1", method: "EVIDENCE" });

    const res = await approveClaim(db as never, { claimId: "c1", actorUserId: ADMIN });
    expect(res.ok).toBe(true);

    const p = promoterRow("p1");
    expect(p.claimed).toBe(1);
    expect(p.user_id).toBe(CLAIMANT);
    expect(p.claimed_by).toBe(CLAIMANT);
    expect(roleRows(CLAIMANT).map((r) => r.role)).toContain("PROMOTER");
    expect(claimRow("c1")).toMatchObject({ status: "APPROVED", decided_by: ADMIN });
    expect(adminActionRows()[0].action).toBe("promoter.claim_admin_review_approve");
  });

  it("refuses when the entity is already claimed by a DIFFERENT user — touches nothing", async () => {
    seedVendor({ id: "v1", slug: "acme-foods", claimed: true, ownerUserId: OTHER });
    seedClaim({ id: "c1", entityType: "VENDOR", entityId: "v1", status: "DISPUTED" });

    const res = await approveClaim(db as never, { claimId: "c1", actorUserId: ADMIN });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("already_claimed_by_other");

    const v = vendorRow("v1");
    expect(v.user_id).toBe(OTHER); // untouched
    expect(v.claimed).toBe(1);
    expect(roleRows(CLAIMANT)).toHaveLength(0);
    expect(claimRow("c1").status).toBe("DISPUTED"); // untouched
    expect(adminActionRows()).toHaveLength(0);
  });

  it("returns not_reviewable for an already-APPROVED claim", async () => {
    seedVendor({ id: "v1", slug: "acme-foods" });
    seedClaim({ id: "c1", entityType: "VENDOR", entityId: "v1", status: "APPROVED" });

    const res = await approveClaim(db as never, { claimId: "c1", actorUserId: ADMIN });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_reviewable");
    expect(vendorRow("v1").claimed).toBe(0);
    expect(adminActionRows()).toHaveLength(0);
  });

  it("returns not_found for a missing claim", async () => {
    const res = await approveClaim(db as never, { claimId: "nope", actorUserId: ADMIN });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_found");
  });
});

describe("rejectClaim", () => {
  it("marks the claim REJECTED with the reason in the audit payload — ownership untouched", async () => {
    seedVendor({ id: "v1", slug: "acme-foods" });
    seedClaim({ id: "c1", entityType: "VENDOR", entityId: "v1" });

    const res = await rejectClaim(db as never, {
      claimId: "c1",
      actorUserId: ADMIN,
      reason: "Could not verify affiliation",
    });
    expect(res.ok).toBe(true);
    expect(res.rejectReason).toBe("Could not verify affiliation");

    expect(claimRow("c1")).toMatchObject({ status: "REJECTED", decided_by: ADMIN });

    const v = vendorRow("v1");
    expect(v.claimed).toBe(0);
    expect(v.user_id).toBe("placeholder-user"); // untouched
    expect(roleRows(CLAIMANT)).toHaveLength(0);

    const actions = adminActionRows();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("vendor.claim_admin_review_reject");
    expect(JSON.parse(actions[0].payload_json!)).toMatchObject({
      via: "admin/claims",
      claimId: "c1",
      reason: "Could not verify affiliation",
    });
  });

  it("returns not_reviewable for an already-decided claim", async () => {
    seedVendor({ id: "v1", slug: "acme-foods" });
    seedClaim({ id: "c1", entityType: "VENDOR", entityId: "v1", status: "REJECTED" });

    const res = await rejectClaim(db as never, {
      claimId: "c1",
      actorUserId: ADMIN,
      reason: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_reviewable");
    expect(adminActionRows()).toHaveLength(0);
  });
});

describe("listReviewableClaims", () => {
  it("returns [] cleanly when there are no claims", async () => {
    expect(await listReviewableClaims(db as never)).toEqual([]);
  });

  it("returns only PENDING + DISPUTED vendor/promoter claims, decorated, newest first", async () => {
    seedVendor({ id: "v1", slug: "acme-foods" });
    seedPromoter({ id: "p1", slug: "big-events-co" });

    seedClaim({
      id: "c-pending",
      entityType: "VENDOR",
      entityId: "v1",
      status: "PENDING",
      createdAt: 1000,
    });
    seedClaim({
      id: "c-disputed",
      entityType: "PROMOTER",
      entityId: "p1",
      status: "DISPUTED",
      createdAt: 2000,
    });
    // Should be excluded:
    seedClaim({
      id: "c-approved",
      entityType: "VENDOR",
      entityId: "v1",
      status: "APPROVED",
      createdAt: 1500,
    });
    seedClaim({
      id: "c-rejected",
      entityType: "VENDOR",
      entityId: "v1",
      status: "REJECTED",
      createdAt: 1600,
    });
    // VENUE is filtered out (no funnel).
    seedClaim({
      id: "c-venue",
      entityType: "VENUE",
      entityId: "venue-1",
      status: "PENDING",
      createdAt: 3000,
    });

    const rows = await listReviewableClaims(db as never);
    expect(rows.map((r) => r.id)).toEqual(["c-disputed", "c-pending"]); // newest first, no venue

    const disputed = rows.find((r) => r.id === "c-disputed")!;
    expect(disputed.entityType).toBe("PROMOTER");
    expect(disputed.entityName).toBe("Big Events Co");
    expect(disputed.entitySlug).toBe("big-events-co");
    expect(disputed.claimantEmail).toBe("claimant@business.com");
    expect(disputed.claimantName).toBe("Claimant Person");
    expect(disputed.status).toBe("DISPUTED");

    // Attempt count = all entity_claims rows for that (type, id). v1 has 3 rows.
    const pending = rows.find((r) => r.id === "c-pending")!;
    expect(pending.attemptCount).toBe(3);
    expect(disputed.attemptCount).toBe(1);
  });
});
