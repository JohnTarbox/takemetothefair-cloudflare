/**
 * OPE-1366 — a JWT session no longer keeps a stale role for 30 days, and a
 * password reset ends the sessions already held.
 *
 * Three layers:
 *   1. refreshSessionToken (the jwt-callback body): demotion reaches the token
 *      at the next re-check; a session_version mismatch or a deleted user ends
 *      it; a D1 failure is fail-open.
 *   2. The two writers, end to end against a real SQLite schema: the admin
 *      role-change PATCH and the reset-password POST each bump
 *      users.session_version, and a token minted before the bump is then
 *      refused by (1).
 *   3. bumpSessionVersion is a relative increment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import {
  refreshSessionToken,
  SESSION_RECHECK_INTERVAL_MS,
  type CurrentUserState,
  type RefreshableToken,
} from "../session-refresh";

// ── SQLite stand-in for D1 (only the tables these paths touch) ──────────────
let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function freshDb() {
  raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT,
      origin TEXT NOT NULL DEFAULT 'registration', name TEXT,
      role TEXT NOT NULL DEFAULT 'USER', email_verified INTEGER, image TEXT,
      oauth_provider TEXT, created_at INTEGER, updated_at INTEGER,
      session_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_roles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
      granted_at INTEGER NOT NULL, granted_by TEXT
    );
    CREATE TABLE password_reset_tokens (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, created_at INTEGER
    );
    CREATE TABLE admin_actions (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT, target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL
    );
  `);
  db = drizzle(raw, { schema });
}

let session: unknown = null;

vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitResponse: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve(session),
  hasRole: (s: { user?: { roles?: string[] } } | null, r: string) => !!s?.user?.roles?.includes(r),
  hashPassword: (p: string) => Promise.resolve(`hashed:${p}`),
}));

/** Same reads as src/lib/auth.ts's loadCurrentUserState, against the SQLite db. */
async function loadUser(userId: string): Promise<CurrentUserState | null> {
  const row = raw.prepare("SELECT role, session_version FROM users WHERE id = ?").get(userId) as
    | { role: CurrentUserState["role"]; session_version: number }
    | undefined;
  if (!row) return null;
  const roles = (
    raw.prepare("SELECT role FROM user_roles WHERE user_id = ?").all(userId) as {
      role: CurrentUserState["role"];
    }[]
  ).map((r) => r.role);
  return { role: row.role, roles, sessionVersion: row.session_version };
}

const T0 = 1_800_000_000_000;
const LATER = T0 + SESSION_RECHECK_INTERVAL_MS + 1;

function seedUser(id: string, role: string, version = 0) {
  raw
    .prepare("INSERT INTO users (id, email, role, session_version) VALUES (?, ?, ?, ?)")
    .run(id, `${id}@example.com`, role, version);
  raw
    .prepare("INSERT INTO user_roles (id, user_id, role, granted_at) VALUES (?, ?, ?, 0)")
    .run(`${id}-r`, id, role);
}

function tokenFor(id: string, role: RefreshableToken["role"], version = 0): RefreshableToken {
  return { id, role, roles: [role!], sessionVersion: version, checkedAt: T0 };
}

const deps = (now: number, logFailure = vi.fn()) => ({ now: () => now, loadUser, logFailure });

beforeEach(() => {
  freshDb();
  session = null;
});

describe("refreshSessionToken (jwt callback)", () => {
  it("a demoted ADMIN loses ADMIN at the next re-check", async () => {
    seedUser("u1", "ADMIN");
    const token = tokenFor("u1", "ADMIN");
    raw.prepare("UPDATE users SET role = 'USER' WHERE id = 'u1'").run();
    raw.prepare("UPDATE user_roles SET role = 'USER' WHERE user_id = 'u1'").run();

    const out = await refreshSessionToken(token, deps(LATER));
    expect(out?.role).toBe("USER");
    expect(out?.roles).toEqual(["USER"]);
    expect(out?.checkedAt).toBe(LATER);
  });

  it("does not hit D1 inside the re-check window", async () => {
    const loadSpy = vi.fn(loadUser);
    const token = tokenFor("u1", "ADMIN");
    const out = await refreshSessionToken(token, {
      now: () => T0 + SESSION_RECHECK_INTERVAL_MS - 1,
      loadUser: loadSpy,
      logFailure: vi.fn(),
    });
    expect(out).toBe(token);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("a session_version mismatch ends the session (null = Auth.js clears the cookie)", async () => {
    seedUser("u1", "USER", 1);
    expect(await refreshSessionToken(tokenFor("u1", "USER", 0), deps(LATER))).toBeNull();
  });

  it("a deleted user ends the session", async () => {
    expect(await refreshSessionToken(tokenFor("gone", "ADMIN"), deps(LATER))).toBeNull();
  });

  it("a pre-OPE-1366 token (no sessionVersion, no checkedAt) survives at version 0 and is ended after a bump", async () => {
    seedUser("u1", "VENDOR");
    const legacy = { id: "u1", role: "VENDOR", roles: ["VENDOR"] } as RefreshableToken;
    expect(await refreshSessionToken({ ...legacy }, deps(T0))).not.toBeNull();
    raw.prepare("UPDATE users SET session_version = 1 WHERE id = 'u1'").run();
    expect(await refreshSessionToken({ ...legacy }, deps(T0))).toBeNull();
  });

  it("D1 failure is fail-open: the token comes back unchanged, checkedAt not advanced, failure logged", async () => {
    const logFailure = vi.fn();
    const token = tokenFor("u1", "ADMIN");
    const out = await refreshSessionToken(token, {
      now: () => LATER,
      loadUser: () => Promise.reject(new Error("D1_ERROR: outage")),
      logFailure,
    });
    expect(out).toEqual(tokenFor("u1", "ADMIN"));
    expect(out?.checkedAt).toBe(T0);
    expect(logFailure).toHaveBeenCalledTimes(1);
  });

  it("an unauthenticated token passes through untouched", async () => {
    const t = {} as RefreshableToken;
    expect(await refreshSessionToken(t, deps(LATER))).toBe(t);
  });
});

describe("writers bump users.session_version, ending sessions minted before", () => {
  it("admin role change (PATCH /api/admin/users/[id]) — the demoted admin's old JWT is refused", async () => {
    seedUser("admin", "ADMIN");
    seedUser("victim", "ADMIN");
    const victimToken = tokenFor("victim", "ADMIN", 0);
    session = { user: { id: "admin", role: "ADMIN", roles: ["ADMIN"] } };

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/admin/users/victim", {
        method: "PATCH",
        body: JSON.stringify({ role: "USER" }),
      }),
      { params: Promise.resolve({ id: "victim" }) }
    );
    expect(res.status).toBe(200);
    expect(
      (
        raw.prepare("SELECT session_version v FROM users WHERE id = 'victim'").get() as {
          v: number;
        }
      ).v
    ).toBe(1);
    expect(await refreshSessionToken(victimToken, deps(LATER))).toBeNull();
  });

  it("a name-only PATCH does not end the session", async () => {
    seedUser("admin", "ADMIN");
    seedUser("u2", "USER");
    session = { user: { id: "admin", role: "ADMIN", roles: ["ADMIN"] } };
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/admin/users/u2", {
        method: "PATCH",
        body: JSON.stringify({ name: "New Name" }),
      }),
      { params: Promise.resolve({ id: "u2" }) }
    );
    expect(res.status).toBe(200);
    expect(await refreshSessionToken(tokenFor("u2", "USER", 0), deps(LATER))).not.toBeNull();
  });

  it("password reset (POST /api/auth/reset-password) — every JWT minted before is refused", async () => {
    seedUser("u1", "USER");
    const stolen = tokenFor("u1", "USER", 0);
    const token = "t".repeat(40);
    raw
      .prepare("INSERT INTO password_reset_tokens (token, user_id, expires) VALUES (?, 'u1', ?)")
      .run(token, Math.floor(Date.now() / 1000) + 3600);

    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(
      new NextRequest("http://localhost/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password: "a-new-password" }),
      })
    );
    expect(res.status).toBe(200);
    expect(await refreshSessionToken(stolen, deps(LATER))).toBeNull();
  });
});

describe("bumpSessionVersion", () => {
  it("increments relative to the current value", async () => {
    seedUser("u1", "USER", 5);
    const { bumpSessionVersion } = await import("../session-version");
    await bumpSessionVersion(db as never, "u1");
    await bumpSessionVersion(db as never, "u1");
    expect(
      (raw.prepare("SELECT session_version v FROM users WHERE id = 'u1'").get() as { v: number }).v
    ).toBe(7);
  });
});
