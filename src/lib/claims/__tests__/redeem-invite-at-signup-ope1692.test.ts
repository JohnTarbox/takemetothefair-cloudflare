/**
 * OPE-1692 — a claim invite must work through the register funnel.
 *
 * Specimen: claim 317c3099 (Owls Head Transportation Museum). The invite went
 * to one mailbox at the organization, a colleague registered with another, and
 * because nothing in /register read `invite=` the claim fell to the contact-
 * email resolver and landed PENDING / EVIDENCE. These tests drive the same path
 * the register route now takes — redeemInviteAtSignup at signup, then
 * approvePendingInviteDomainClaims at email verification — and assert the
 * dashboard condition directly: promoters.user_id = the new account.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import {
  redeemInviteAtSignup,
  approvePendingInviteDomainClaims,
  lookupInvite,
  sameOwnableDomain,
} from "../redeem-invite-at-signup";
import type { Database as AppDb } from "@/lib/db";

const SCHEMA_SQL = `
  CREATE TABLE users (
    -- OPE-292 — mirrors the users.origin column; NOT NULL with a default.
    origin TEXT NOT NULL DEFAULT 'registration',
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'USER',
    email_verified INTEGER,
    image TEXT,
    oauth_provider TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    session_version INTEGER NOT NULL DEFAULT 0
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
    deleted_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    company_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    contact_email TEXT,
    claimed INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    claimed_by TEXT,
    updated_at INTEGER
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
let db: AppDb;

const TOKEN = "f".repeat(64);
const PROMOTER_ID = "promoter-ohtm";
const USER_ID = "user-new";

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seed(opts: {
  invitedEmail: string;
  accountEmail: string;
  expiresInMs?: number;
  claimedBy?: string | null;
}) {
  raw
    .prepare(
      `INSERT INTO promoters (id, user_id, company_name, slug, contact_email, claimed)
       VALUES (?, ?, 'Owls Head Transportation Museum', 'owls-head-transportation-museum', NULL, ?)`
    )
    .run(PROMOTER_ID, opts.claimedBy ?? null, opts.claimedBy ? 1 : 0);
  raw
    .prepare(`INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Claimant', 'PROMOTER')`)
    .run(USER_ID, opts.accountEmail);
  const now = Math.floor(Date.now() / 1000);
  raw
    .prepare(
      `INSERT INTO claim_tokens (id, entity_type, entity_id, user_id, email, token_hash, created_at, expires_at)
       VALUES ('tok-1', 'PROMOTER', ?, NULL, ?, ?, ?, ?)`
    )
    .run(
      PROMOTER_ID,
      opts.invitedEmail,
      await sha256Hex(TOKEN),
      now,
      now + Math.floor((opts.expiresInMs ?? 14 * 86400_000) / 1000)
    );
}

const promoterOwner = () =>
  raw.prepare(`SELECT user_id, claimed FROM promoters WHERE id = ?`).get(PROMOTER_ID) as {
    user_id: string | null;
    claimed: number;
  };
const claims = () =>
  raw.prepare(`SELECT method, status FROM entity_claims WHERE user_id = ?`).all(USER_ID) as Array<{
    method: string;
    status: string;
  }>;
const tokenCount = () =>
  (raw.prepare(`SELECT COUNT(*) n FROM claim_tokens`).get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
});
afterEach(() => raw.close());

describe("OPE-1692 invite → register → verify → dashboard", () => {
  it("exact invited address: approved at signup, dashboard linked, token consumed", async () => {
    await seed({
      invitedEmail: "staff.one@museum.example.org",
      accountEmail: "staff.one@museum.example.org",
    });
    const res = await redeemInviteAtSignup(db, {
      rawToken: TOKEN,
      userId: USER_ID,
      userEmail: "Staff.One@museum.example.org",
      role: "PROMOTER",
    });
    expect(res.kind).toBe("redeemed");
    expect(promoterOwner()).toEqual({ user_id: USER_ID, claimed: 1 });
    expect(claims()).toEqual([{ method: "INVITE_TOKEN", status: "APPROVED" }]);
    expect(tokenCount()).toBe(0);
  });

  it("colleague on the same domain (the 317c3099 shape): PENDING at signup, approved on verify", async () => {
    await seed({
      invitedEmail: "staff.one@museum.example.org",
      accountEmail: "staff.two@museum.example.org",
    });
    const res = await redeemInviteAtSignup(db, {
      rawToken: TOKEN,
      userId: USER_ID,
      userEmail: "staff.two@museum.example.org",
      role: "PROMOTER",
    });
    expect(res.kind).toBe("pending_verification");
    // Not yet: a forwarded link alone transfers nothing.
    expect(promoterOwner()).toEqual({ user_id: null, claimed: 0 });
    expect(claims()).toEqual([{ method: "INVITE_TOKEN", status: "PENDING" }]);

    const verified = await approvePendingInviteDomainClaims(
      db,
      USER_ID,
      "staff.two@museum.example.org"
    );
    expect(verified.approved).toBe(1);
    expect(verified.approvedClaims).toEqual([
      { entityType: "PROMOTER", entitySlug: "owls-head-transportation-museum" },
    ]);
    expect(promoterOwner()).toEqual({ user_id: USER_ID, claimed: 1 });
    expect(claims()).toEqual([{ method: "INVITE_TOKEN", status: "APPROVED" }]);
    expect(tokenCount()).toBe(0);
    const notes = raw.prepare(`SELECT type FROM notifications WHERE user_id = ?`).all(USER_ID);
    expect(notes).toEqual([{ type: "claim_approved" }]);
  });

  it("different domain: not applicable, nothing written (falls back to the old resolver)", async () => {
    await seed({
      invitedEmail: "staff.one@museum.example.org",
      accountEmail: "someone@other.example.net",
    });
    const res = await redeemInviteAtSignup(db, {
      rawToken: TOKEN,
      userId: USER_ID,
      userEmail: "someone@other.example.net",
      role: "PROMOTER",
    });
    expect(res).toEqual({ kind: "not_applicable", reason: "email_mismatch" });
    expect(claims()).toEqual([]);
    expect(promoterOwner().claimed).toBe(0);
  });

  it("freemail never counts as the same organization", async () => {
    await seed({ invitedEmail: "test.museum@gmail.com", accountEmail: "test.intruder@gmail.com" });
    const res = await redeemInviteAtSignup(db, {
      rawToken: TOKEN,
      userId: USER_ID,
      userEmail: "test.intruder@gmail.com",
      role: "PROMOTER",
    });
    expect(res.kind).toBe("not_applicable");
    expect(sameOwnableDomain("test.a@gmail.com", "test.b@gmail.com")).toBe(false);
    expect(sameOwnableDomain("a@museum.example.org", "b@museum.example.org")).toBe(true);
  });

  it("expired token: not applicable", async () => {
    await seed({
      invitedEmail: "staff.one@museum.example.org",
      accountEmail: "staff.one@museum.example.org",
      expiresInMs: -1000,
    });
    const res = await redeemInviteAtSignup(db, {
      rawToken: TOKEN,
      userId: USER_ID,
      userEmail: "staff.one@museum.example.org",
      role: "PROMOTER",
    });
    expect(res).toEqual({ kind: "not_applicable", reason: "expired" });
    expect(promoterOwner().claimed).toBe(0);
  });

  it("already claimed by someone else: no takeover", async () => {
    await seed({
      invitedEmail: "staff.one@museum.example.org",
      accountEmail: "staff.one@museum.example.org",
      claimedBy: "other-user",
    });
    const res = await redeemInviteAtSignup(db, {
      rawToken: TOKEN,
      userId: USER_ID,
      userEmail: "staff.one@museum.example.org",
      role: "PROMOTER",
    });
    expect(res).toEqual({ kind: "not_applicable", reason: "already_claimed_by_other" });
    expect(promoterOwner()).toEqual({ user_id: "other-user", claimed: 1 });
  });

  it("verify step leaves the claim PENDING if the token expired in between", async () => {
    await seed({
      invitedEmail: "staff.one@museum.example.org",
      accountEmail: "staff.two@museum.example.org",
    });
    await redeemInviteAtSignup(db, {
      rawToken: TOKEN,
      userId: USER_ID,
      userEmail: "staff.two@museum.example.org",
      role: "PROMOTER",
    });
    raw.prepare(`UPDATE claim_tokens SET expires_at = 1`).run();
    const verified = await approvePendingInviteDomainClaims(
      db,
      USER_ID,
      "staff.two@museum.example.org"
    );
    expect(verified.approved).toBe(0);
    expect(claims()).toEqual([{ method: "INVITE_TOKEN", status: "PENDING" }]);
    expect(promoterOwner().claimed).toBe(0);
  });

  it("lookupInvite names the entity and never needs the email to do it", async () => {
    await seed({
      invitedEmail: "staff.one@museum.example.org",
      accountEmail: "x@museum.example.org",
    });
    const inv = await lookupInvite(db, TOKEN);
    expect(inv?.entityName).toBe("Owls Head Transportation Museum");
    expect(inv?.expired).toBe(false);
    expect(await lookupInvite(db, "nope")).toBeNull();
  });
});
