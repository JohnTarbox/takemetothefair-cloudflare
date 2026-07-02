/**
 * OPE-59 / OPE-61 — resolveClaimAtSignup claim-decision core.
 *
 * Exercises the three hard invariants against better-sqlite3:
 *   1. No unverified claim   — only a contact-email match approves.
 *   2. No overwrite          — an already-claimed entity is untouched (DISPUTED).
 *   3. Every attempt logged  — an entity_claims row is written for every found
 *                              entity (approved / pending / disputed).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { resolveClaimAtSignup, approvePendingEmailMatchClaims } from "../resolve-claim-at-signup";

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
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NEW_USER = "user-new";
const NEW_EMAIL = "owner@business.com";

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(`INSERT INTO users (id, email, password_hash, email_verified) VALUES (?, ?, ?, ?)`)
    .run(NEW_USER, NEW_EMAIL, "hash", 1);
});
afterEach(() => raw.close());

function seedVendor(opts: {
  id: string;
  slug: string;
  contactEmail?: string | null;
  claimed?: boolean;
  ownerUserId?: string;
  deleted?: boolean;
}) {
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, contact_email, claimed, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.ownerUserId ?? "placeholder-user",
      "Acme Foods",
      opts.slug,
      opts.contactEmail ?? null,
      opts.claimed ? 1 : 0,
      opts.deleted ? Math.floor(Date.now() / 1000) : null
    );
}

function seedPromoter(opts: {
  id: string;
  slug: string;
  contactEmail?: string | null;
  claimed?: boolean;
  ownerUserId?: string;
}) {
  raw
    .prepare(
      `INSERT INTO promoters (id, user_id, company_name, slug, contact_email, claimed)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.ownerUserId ?? null,
      "Big Events Co",
      opts.slug,
      opts.contactEmail ?? null,
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
function promoterRow(id: string) {
  return raw.prepare(`SELECT * FROM promoters WHERE id = ?`).get(id) as {
    user_id: string | null;
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

describe("resolveClaimAtSignup — VENDOR", () => {
  it("email match → pending_verification: logs PENDING EMAIL_MATCH, claims NOTHING until email verified", async () => {
    seedVendor({ id: "v1", slug: "acme-foods", contactEmail: "owner@business.com" });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("pending_verification");

    // SECURITY: the typed email is unverified at signup — nothing is claimed,
    // no role granted. Approval waits for the verification click.
    const v = vendorRow("v1");
    expect(v.claimed).toBe(0);
    expect(v.claimed_by).toBeNull();
    expect(roleRows(NEW_USER)).toHaveLength(0);

    const claims = claimsFor("v1");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      user_id: NEW_USER,
      method: "EMAIL_MATCH",
      status: "PENDING",
    });
  });

  it("email match is case/whitespace-insensitive (still pending until verified)", async () => {
    seedVendor({ id: "v1", slug: "acme-foods", contactEmail: "  OWNER@Business.com " });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("pending_verification");
    expect(vendorRow("v1").claimed).toBe(0);
  });

  it("no match → needs_evidence: does NOT claim, logs PENDING EVIDENCE", async () => {
    seedVendor({ id: "v1", slug: "acme-foods", contactEmail: "someoneelse@other.com" });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("needs_evidence");

    const v = vendorRow("v1");
    expect(v.claimed).toBe(0);
    expect(v.user_id).toBe("placeholder-user"); // untouched
    expect(roleRows(NEW_USER)).toHaveLength(0);

    const claims = claimsFor("v1");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ status: "PENDING", method: "EVIDENCE" });
  });

  it("no contact email → needs_evidence (never auto-claims a placeholder listing)", async () => {
    seedVendor({ id: "v1", slug: "acme-foods", contactEmail: null });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("needs_evidence");
    expect(vendorRow("v1").claimed).toBe(0);
    expect(claimsFor("v1")[0].status).toBe("PENDING");
  });

  it("already claimed by a different user → already_claimed: untouched, logs DISPUTED", async () => {
    seedVendor({
      id: "v1",
      slug: "acme-foods",
      contactEmail: "owner@business.com", // even a matching email must NOT overwrite
      claimed: true,
      ownerUserId: "other-owner",
    });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("already_claimed");

    const v = vendorRow("v1");
    expect(v.claimed).toBe(1);
    expect(v.user_id).toBe("other-owner"); // NEVER overwritten
    expect(roleRows(NEW_USER)).toHaveLength(0);

    const claims = claimsFor("v1");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ status: "DISPUTED", user_id: NEW_USER });
  });

  it("unknown slug → entity_not_found: nothing written", async () => {
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "does-not-exist",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("entity_not_found");
    expect(res.claimId).toBeUndefined();
    const allClaims = raw.prepare(`SELECT COUNT(*) AS n FROM entity_claims`).get() as { n: number };
    expect(allClaims.n).toBe(0);
  });

  it("soft-deleted vendor is invisible → entity_not_found", async () => {
    seedVendor({
      id: "v1",
      slug: "acme-foods",
      contactEmail: "owner@business.com",
      deleted: true,
    });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("entity_not_found");
  });
});

describe("resolveClaimAtSignup — PROMOTER", () => {
  it("email match → pending_verification: logs PENDING, claims NOTHING until verified", async () => {
    seedPromoter({ id: "p1", slug: "big-events-co", contactEmail: "owner@business.com" });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "PROMOTER",
      slug: "big-events-co",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("pending_verification");

    const p = promoterRow("p1");
    expect(p.claimed).toBe(0);
    expect(p.claimed_by).toBeNull();
    expect(roleRows(NEW_USER)).toHaveLength(0);

    const claims = claimsFor("p1");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ method: "EMAIL_MATCH", status: "PENDING" });
  });

  it("no match → needs_evidence: does NOT claim, logs PENDING", async () => {
    seedPromoter({ id: "p1", slug: "big-events-co", contactEmail: "different@x.com" });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "PROMOTER",
      slug: "big-events-co",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("needs_evidence");
    expect(promoterRow("p1").claimed).toBe(0);
    expect(claimsFor("p1")[0].status).toBe("PENDING");
    expect(roleRows(NEW_USER)).toHaveLength(0);
  });

  it("already claimed by a different user → already_claimed, untouched", async () => {
    seedPromoter({
      id: "p1",
      slug: "big-events-co",
      contactEmail: "owner@business.com",
      claimed: true,
      ownerUserId: "other-owner",
    });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "PROMOTER",
      slug: "big-events-co",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("already_claimed");
    expect(promoterRow("p1").user_id).toBe("other-owner");
    expect(claimsFor("p1")[0].status).toBe("DISPUTED");
  });
});

describe("approvePendingEmailMatchClaims — verified approval (OPE-59 security fix)", () => {
  // Reproduce a signup email-match (which now only records PENDING), then run
  // the verify-time approval and assert ownership only transfers here.
  async function signupEmailMatch() {
    seedVendor({ id: "v1", slug: "acme-foods", contactEmail: "owner@business.com" });
    const res = await resolveClaimAtSignup(db as never, {
      entityType: "VENDOR",
      slug: "acme-foods",
      userId: NEW_USER,
      userEmail: NEW_EMAIL,
    });
    expect(res.outcome).toBe("pending_verification");
    expect(vendorRow("v1").claimed).toBe(0); // not claimed at signup
  }

  it("approves the PENDING email-match claim once the email is verified", async () => {
    await signupEmailMatch();
    const r = await approvePendingEmailMatchClaims(db as never, NEW_USER, NEW_EMAIL);
    expect(r.approved).toBe(1);
    const v = vendorRow("v1");
    expect(v.claimed).toBe(1);
    expect(v.user_id).toBe(NEW_USER);
    expect(v.claimed_by).toBe(NEW_USER);
    expect(roleRows(NEW_USER).map((x) => x.role)).toContain("VENDOR");
    expect(claimsFor("v1")[0]).toMatchObject({ status: "APPROVED", decided_by: NEW_USER });
  });

  it("does NOT overwrite a claim taken by another user in the interim → DISPUTED", async () => {
    await signupEmailMatch();
    raw.prepare(`UPDATE vendors SET claimed = 1, user_id = ? WHERE id = 'v1'`).run("other-owner");
    const r = await approvePendingEmailMatchClaims(db as never, NEW_USER, NEW_EMAIL);
    expect(r.approved).toBe(0);
    expect(vendorRow("v1").user_id).toBe("other-owner"); // untouched
    expect(claimsFor("v1")[0].status).toBe("DISPUTED");
    expect(roleRows(NEW_USER)).toHaveLength(0);
  });

  it("leaves the claim PENDING if the contact email changed before verification", async () => {
    await signupEmailMatch();
    raw.prepare(`UPDATE vendors SET contact_email = ? WHERE id = 'v1'`).run("changed@x.com");
    const r = await approvePendingEmailMatchClaims(db as never, NEW_USER, NEW_EMAIL);
    expect(r.approved).toBe(0);
    expect(vendorRow("v1").claimed).toBe(0);
    expect(claimsFor("v1")[0].status).toBe("PENDING");
  });

  it("is idempotent — a second verification approves nothing new", async () => {
    await signupEmailMatch();
    await approvePendingEmailMatchClaims(db as never, NEW_USER, NEW_EMAIL);
    const r2 = await approvePendingEmailMatchClaims(db as never, NEW_USER, NEW_EMAIL);
    expect(r2.approved).toBe(0);
    expect(roleRows(NEW_USER).filter((x) => x.role === "VENDOR")).toHaveLength(1);
  });
});
