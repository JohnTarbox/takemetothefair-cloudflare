/**
 * OPE-64 — resolveClaimInWizard + approvePendingDomainMatchClaims.
 *
 * Exercises the ladder and the #1 security invariant against better-sqlite3:
 *   - domain match + VERIFIED email → instant approve (ownership transferred,
 *     DOMAIN_MATCH APPROVED, role granted, audit written).
 *   - domain match + UNVERIFIED email → PENDING only (NO ownership change), then
 *     approvePendingDomainMatchClaims after verification → approved.
 *   - website changed before verification → NOT approved (stays PENDING).
 *   - freemail / social-builder email → needs_evidence (no auto-approve).
 *   - already claimed by another user → DISPUTED, untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { resolveClaimInWizard, approvePendingDomainMatchClaims } from "../resolve-claim-in-wizard";

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT,
    email_verified INTEGER
  );
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    business_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    contact_email TEXT,
    website TEXT,
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
    website TEXT,
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
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    data TEXT,
    created_at INTEGER
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const USER = "user-new";
const EMAIL = "jane@acme.com";

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(`INSERT INTO users (id, email, password_hash, email_verified) VALUES (?, ?, ?, ?)`)
    .run(USER, EMAIL, "hash", null);
});
afterEach(() => raw.close());

function setVerified(v: boolean) {
  raw.prepare(`UPDATE users SET email_verified = ? WHERE id = ?`).run(v ? 1 : null, USER);
}

function seedVendor(opts: {
  id: string;
  slug: string;
  contactEmail?: string | null;
  website?: string | null;
  claimed?: boolean;
  ownerUserId?: string;
  deleted?: boolean;
}) {
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, contact_email, website, claimed, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.ownerUserId ?? "placeholder-user",
      "Acme Foods",
      opts.slug,
      opts.contactEmail ?? null,
      opts.website ?? null,
      opts.claimed ? 1 : 0,
      opts.deleted ? Math.floor(Date.now() / 1000) : null
    );
}

function seedPromoter(opts: {
  id: string;
  slug: string;
  contactEmail?: string | null;
  website?: string | null;
  claimed?: boolean;
  ownerUserId?: string | null;
}) {
  raw
    .prepare(
      `INSERT INTO promoters (id, user_id, company_name, slug, contact_email, website, claimed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.ownerUserId ?? null,
      "Big Events Co",
      opts.slug,
      opts.contactEmail ?? null,
      opts.website ?? null,
      opts.claimed ? 1 : 0
    );
}

function vendorRow(id: string) {
  return raw.prepare(`SELECT * FROM vendors WHERE id = ?`).get(id) as {
    user_id: string;
    claimed: number;
    claimed_by: string | null;
  };
}
function claimsFor(entityId: string) {
  return raw.prepare(`SELECT * FROM entity_claims WHERE entity_id = ?`).all(entityId) as Array<{
    user_id: string;
    method: string;
    status: string;
    decided_by: string | null;
  }>;
}
function roleRows(userId: string) {
  return raw.prepare(`SELECT * FROM user_roles WHERE user_id = ?`).all(userId) as Array<{
    role: string;
  }>;
}
function notifs(userId: string) {
  return raw.prepare(`SELECT * FROM notifications WHERE user_id = ?`).all(userId) as Array<{
    type: string;
  }>;
}

describe("resolveClaimInWizard — domain match", () => {
  it("domain match + VERIFIED → approved: transfers ownership, DOMAIN_MATCH APPROVED, role + audit + notification", async () => {
    setVerified(true);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://acme.com" });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("approved");
    expect(res.method).toBe("DOMAIN_MATCH");

    const v = vendorRow("v1");
    expect(v.claimed).toBe(1);
    expect(v.user_id).toBe(USER);
    expect(v.claimed_by).toBe(USER);
    expect(roleRows(USER).map((r) => r.role)).toContain("VENDOR");

    const claims = claimsFor("v1");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      method: "DOMAIN_MATCH",
      status: "APPROVED",
      decided_by: USER,
    });

    const actions = raw.prepare(`SELECT * FROM admin_actions`).all() as Array<{ action: string }>;
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("vendor.claim_wizard_approve");

    expect(notifs(USER).map((n) => n.type)).toContain("claim_approved");
  });

  it("domain match + UNVERIFIED → PENDING only (NO ownership change), then verify approves", async () => {
    setVerified(false);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://acme.com" });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: false,
    });
    expect(res.outcome).toBe("pending_verification");
    expect(res.method).toBe("DOMAIN_MATCH");

    // SECURITY: nothing claimed while unverified.
    expect(vendorRow("v1").claimed).toBe(0);
    expect(roleRows(USER)).toHaveLength(0);
    expect(claimsFor("v1")[0]).toMatchObject({ method: "DOMAIN_MATCH", status: "PENDING" });

    // Verification callback re-validates + approves.
    const r = await approvePendingDomainMatchClaims(db as never, USER, EMAIL);
    expect(r.approved).toBe(1);
    expect(vendorRow("v1").claimed).toBe(1);
    expect(vendorRow("v1").user_id).toBe(USER);
    expect(roleRows(USER).map((x) => x.role)).toContain("VENDOR");
    expect(claimsFor("v1")[0]).toMatchObject({ status: "APPROVED", decided_by: USER });
  });

  it("website CHANGED before verification → NOT approved (stays PENDING)", async () => {
    setVerified(false);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://acme.com" });
    await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: false,
    });
    // Website changes to a different registrable domain before the user verifies.
    raw.prepare(`UPDATE vendors SET website = ? WHERE id = 'v1'`).run("https://someoneelse.com");

    const r = await approvePendingDomainMatchClaims(db as never, USER, EMAIL);
    expect(r.approved).toBe(0);
    expect(vendorRow("v1").claimed).toBe(0);
    expect(claimsFor("v1")[0].status).toBe("PENDING"); // NOT approved, NOT disputed
    expect(roleRows(USER)).toHaveLength(0);
  });

  it("website cleared before verification → NOT approved (stays PENDING)", async () => {
    setVerified(false);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://acme.com" });
    await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: false,
    });
    raw.prepare(`UPDATE vendors SET website = NULL WHERE id = 'v1'`).run();
    const r = await approvePendingDomainMatchClaims(db as never, USER, EMAIL);
    expect(r.approved).toBe(0);
    expect(claimsFor("v1")[0].status).toBe("PENDING");
  });

  it("claimed by someone else before verification → DISPUTED, untouched", async () => {
    setVerified(false);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://acme.com" });
    await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: false,
    });
    raw.prepare(`UPDATE vendors SET claimed = 1, user_id = ? WHERE id = 'v1'`).run("other-owner");
    const r = await approvePendingDomainMatchClaims(db as never, USER, EMAIL);
    expect(r.approved).toBe(0);
    expect(vendorRow("v1").user_id).toBe("other-owner");
    expect(claimsFor("v1")[0].status).toBe("DISPUTED");
  });

  it("is idempotent — a second verification approves nothing new", async () => {
    setVerified(false);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://acme.com" });
    await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: false,
    });
    await approvePendingDomainMatchClaims(db as never, USER, EMAIL);
    const r2 = await approvePendingDomainMatchClaims(db as never, USER, EMAIL);
    expect(r2.approved).toBe(0);
    expect(roleRows(USER).filter((x) => x.role === "VENDOR")).toHaveLength(1);
  });
});

describe("resolveClaimInWizard — ladder ordering & non-matches", () => {
  it("freemail email → needs_evidence (no auto-approve even when verified)", async () => {
    setVerified(true);
    raw.prepare(`UPDATE users SET email = ? WHERE id = ?`).run("jane@gmail.com", USER);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://gmail.com" });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: "jane@gmail.com",
      emailVerified: true,
    });
    expect(res.outcome).toBe("needs_evidence");
    expect(res.method).toBe("EVIDENCE");
    expect(vendorRow("v1").claimed).toBe(0);
    expect(claimsFor("v1")[0]).toMatchObject({ method: "EVIDENCE", status: "PENDING" });
  });

  it("social-builder website → needs_evidence", async () => {
    setVerified(true);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://facebook.com/acme" });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("needs_evidence");
    expect(vendorRow("v1").claimed).toBe(0);
  });

  it("email match takes precedence over domain match (rung order)", async () => {
    setVerified(true);
    seedVendor({
      id: "v1",
      slug: "acme-foods",
      contactEmail: "jane@acme.com",
      website: "https://acme.com",
    });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("approved");
    expect(res.method).toBe("EMAIL_MATCH");
  });

  it("email match + UNVERIFIED → pending_verification (EMAIL_MATCH), nothing claimed", async () => {
    setVerified(false);
    seedVendor({ id: "v1", slug: "acme-foods", contactEmail: "jane@acme.com" });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: false,
    });
    expect(res.outcome).toBe("pending_verification");
    expect(res.method).toBe("EMAIL_MATCH");
    expect(vendorRow("v1").claimed).toBe(0);
  });

  it("already claimed by a DIFFERENT user → already_claimed, DISPUTED, untouched", async () => {
    setVerified(true);
    seedVendor({
      id: "v1",
      slug: "acme-foods",
      website: "https://acme.com",
      claimed: true,
      ownerUserId: "other-owner",
    });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("already_claimed");
    expect(vendorRow("v1").user_id).toBe("other-owner");
    expect(claimsFor("v1")[0].status).toBe("DISPUTED");
    expect(roleRows(USER)).toHaveLength(0);
  });

  it("already claimed by the SAME user → already_yours, no new row", async () => {
    setVerified(true);
    seedVendor({
      id: "v1",
      slug: "acme-foods",
      website: "https://acme.com",
      claimed: true,
      ownerUserId: USER,
    });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("already_yours");
    expect(claimsFor("v1")).toHaveLength(0);
  });

  it("unknown slug → entity_not_found, nothing written", async () => {
    setVerified(true);
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "nope",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("entity_not_found");
    const n = raw.prepare(`SELECT COUNT(*) AS n FROM entity_claims`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("soft-deleted vendor → entity_not_found", async () => {
    setVerified(true);
    seedVendor({ id: "v1", slug: "acme-foods", website: "https://acme.com", deleted: true });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("entity_not_found");
  });
});

describe("resolveClaimInWizard — PROMOTER domain match", () => {
  it("domain match + VERIFIED → approved, PROMOTER role granted", async () => {
    setVerified(true);
    seedPromoter({ id: "p1", slug: "big-events-co", website: "https://acme.com" });
    const res = await resolveClaimInWizard(db as never, {
      entityType: "PROMOTER",
      slug: "big-events-co",
      userId: USER,
      userEmail: EMAIL,
      emailVerified: true,
    });
    expect(res.outcome).toBe("approved");
    expect(res.method).toBe("DOMAIN_MATCH");
    const p = raw.prepare(`SELECT * FROM promoters WHERE id = 'p1'`).get() as {
      claimed: number;
      user_id: string | null;
    };
    expect(p.claimed).toBe(1);
    expect(p.user_id).toBe(USER);
    expect(roleRows(USER).map((r) => r.role)).toContain("PROMOTER");
  });
});
