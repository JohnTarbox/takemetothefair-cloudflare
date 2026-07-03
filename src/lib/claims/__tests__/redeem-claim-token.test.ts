/**
 * OPE-67 — redeemClaimToken cold-invite redemption core.
 *
 * Same better-sqlite3 harness as resolve-claim-at-signup.test.ts, plus the
 * claim_tokens + admin_actions tables. Exercises:
 *   - valid redeem → ownership + role + entity_claims INVITE_TOKEN APPROVED,
 *     token consumed, emailVerified set
 *   - expired token → expired
 *   - account email ≠ token email → email_mismatch (no takeover)
 *   - entity already claimed by another user → already_claimed_by_other
 *   - unknown token hash → invalid
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import { redeemClaimToken } from "../redeem-claim-token";
import { vendors, users, userRoles, entityClaims, claimTokens } from "../../db/schema";

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'USER',
    email_verified INTEGER,
    image TEXT,
    oauth_provider TEXT,
    created_at INTEGER,
    updated_at INTEGER
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
  CREATE TABLE claim_tokens (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    user_id TEXT,
    email TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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

const RAW_TOKEN = "abc123def456";
const USER_ID = "user-1";
const USER_EMAIL = "owner@acme.test";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Seed via raw prepared statements (mirrors resolve-claim-at-signup.test.ts) so
// Drizzle's default-column emission doesn't require every table column here.
function seedUser(over: { id?: string; email?: string; emailVerified?: Date | null } = {}) {
  raw
    .prepare(`INSERT INTO users (id, email, email_verified) VALUES (?, ?, ?)`)
    .run(
      over.id ?? USER_ID,
      over.email ?? USER_EMAIL,
      over.emailVerified ? Math.floor(over.emailVerified.getTime() / 1000) : null
    );
}

function seedVendor(over: { id?: string; userId?: string; slug?: string; claimed?: boolean } = {}) {
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, claimed) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      over.id ?? "v-1",
      over.userId ?? "placeholder",
      "Acme Crafts",
      over.slug ?? "acme-crafts",
      over.claimed ? 1 : 0
    );
}

async function seedToken(
  over: {
    id?: string;
    entityType?: string;
    entityId?: string;
    userId?: string | null;
    email?: string | null;
    tokenHash?: string;
    expiresAt?: Date;
  } = {},
  rawToken = RAW_TOKEN
) {
  raw
    .prepare(
      `INSERT INTO claim_tokens (id, entity_type, entity_id, user_id, email, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      over.id ?? "tok-1",
      over.entityType ?? "VENDOR",
      over.entityId ?? "v-1",
      over.userId ?? null,
      over.email === undefined ? USER_EMAIL : over.email,
      over.tokenHash ?? (await sha256Hex(rawToken)),
      Math.floor(Date.now() / 1000),
      Math.floor((over.expiresAt ?? new Date(Date.now() + 14 * 24 * 3600 * 1000)).getTime() / 1000)
    );
}

// Read only the columns the minimal test vendors table actually has (a
// `SELECT *` would reference schema columns absent from this bootstrap).
async function readVendor(id: string) {
  const [row] = await db
    .select({
      userId: vendors.userId,
      claimed: vendors.claimed,
      claimedBy: vendors.claimedBy,
    })
    .from(vendors)
    .where(eq(vendors.id, id));
  return row;
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

describe("redeemClaimToken (OPE-67)", () => {
  it("valid redeem transfers ownership, grants role, writes APPROVED claim, verifies email, consumes token", async () => {
    seedUser();
    seedVendor({ id: "v-1", claimed: false });
    await seedToken();

    const result = await redeemClaimToken(db as never, { rawToken: RAW_TOKEN, userId: USER_ID });
    expect(result.ok).toBe(true);
    expect(result.entityType).toBe("VENDOR");
    expect(result.entitySlug).toBe("acme-crafts");

    const vendor = await readVendor("v-1");
    expect(vendor.claimed).toBe(true);
    expect(vendor.userId).toBe(USER_ID);
    expect(vendor.claimedBy).toBe(USER_ID);

    const roles = await db.select().from(userRoles).where(eq(userRoles.userId, USER_ID));
    expect(roles.some((r) => r.role === "VENDOR")).toBe(true);

    const claims = await db.select().from(entityClaims);
    expect(claims).toHaveLength(1);
    expect(claims[0].method).toBe("INVITE_TOKEN");
    expect(claims[0].status).toBe("APPROVED");
    expect(claims[0].decidedBy).toBe(USER_ID);

    const [user] = await db.select().from(users).where(eq(users.id, USER_ID));
    expect(user.emailVerified).not.toBeNull();

    // Single use — token consumed.
    expect(await db.select().from(claimTokens)).toHaveLength(0);
  });

  it("does not clobber an already-verified email timestamp", async () => {
    const original = new Date(Math.floor((Date.now() - 100000) / 1000) * 1000);
    seedUser({ emailVerified: original });
    seedVendor({ id: "v-1" });
    await seedToken();

    await redeemClaimToken(db as never, { rawToken: RAW_TOKEN, userId: USER_ID });
    const [user] = await db.select().from(users).where(eq(users.id, USER_ID));
    expect(user.emailVerified?.getTime()).toBe(original.getTime());
  });

  it("expired token → expired", async () => {
    seedUser();
    seedVendor({ id: "v-1" });
    await seedToken({ expiresAt: new Date(Date.now() - 1000) });

    const result = await redeemClaimToken(db as never, { rawToken: RAW_TOKEN, userId: USER_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("expired");
    expect(await db.select().from(entityClaims)).toHaveLength(0);
  });

  it("account email ≠ token email → email_mismatch, no takeover", async () => {
    seedUser({ email: "someone@else.test" });
    seedVendor({ id: "v-1", claimed: false });
    await seedToken({ email: USER_EMAIL });

    const result = await redeemClaimToken(db as never, { rawToken: RAW_TOKEN, userId: USER_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("email_mismatch");

    const vendor = await readVendor("v-1");
    expect(vendor.claimed).toBe(false);
    // Token not consumed.
    expect(await db.select().from(claimTokens)).toHaveLength(1);
  });

  it("entity already claimed by another user → already_claimed_by_other", async () => {
    seedUser();
    seedVendor({ id: "v-1", userId: "other-owner", claimed: true });
    await seedToken();

    const result = await redeemClaimToken(db as never, { rawToken: RAW_TOKEN, userId: USER_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already_claimed_by_other");

    const vendor = await readVendor("v-1");
    expect(vendor.userId).toBe("other-owner"); // untouched
  });

  it("unknown token hash → invalid", async () => {
    seedUser();
    seedVendor({ id: "v-1" });
    // No token seeded.
    const result = await redeemClaimToken(db as never, {
      rawToken: "nonexistent",
      userId: USER_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid");
  });

  it("email match is case-insensitive", async () => {
    seedUser({ email: "Owner@Acme.Test" });
    seedVendor({ id: "v-1", claimed: false });
    await seedToken({ email: "owner@acme.test" });

    const result = await redeemClaimToken(db as never, { rawToken: RAW_TOKEN, userId: USER_ID });
    expect(result.ok).toBe(true);
  });
});
