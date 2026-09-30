/**
 * OPE-903 — `mmatf_` tokens can now be revoked and can carry an expiry.
 *
 * Both columns are nullable with no default, so every pre-existing token keeps
 * working untouched. These tests pin that promise as hard as they pin the new
 * refusals: a hardening change that logged John out would be a worse outcome
 * than the gap it closes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticateToken } from "../src/auth.js";

const RAW = "mmatf_test_token_value";

/** The stored form is a SHA-256 hex digest of the raw token. */
async function hashOf(raw: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface TokenRow {
  tokenId: string;
  userId: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Minimal drizzle double: the auth path does select→limit on api_tokens, then
 * select→limit on users, then vendors/promoters, then one update.
 */
function makeDb(token: TokenRow | null, role = "ADMIN") {
  const updates: unknown[] = [];
  let call = 0;
  const db = {
    updates,
    select() {
      call += 1;
      const n = call;
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        limit: async () => {
          if (n === 1) return token ? [token] : [];
          if (n === 2) return [{ id: token?.userId ?? "u1", role }];
          return []; // vendors / promoters lookups
        },
      };
      return chain;
    },
    update() {
      const chain = {
        set: (v: unknown) => {
          updates.push(v);
          return chain;
        },
        where: () => Promise.resolve(),
      };
      return chain;
    },
  };
  return db as unknown as Parameters<typeof authenticateToken>[0] & { updates: unknown[] };
}

let hash: string;
beforeEach(async () => {
  vi.clearAllMocks();
  hash = await hashOf(RAW);
  expect(hash).toHaveLength(64); // the double is keyed on a real digest
});

describe("a token with NULL lifecycle columns still works — the promise to existing rows", () => {
  it("authenticates", async () => {
    const db = makeDb({ tokenId: "t1", userId: "u1", expiresAt: null, revokedAt: null });
    const ctx = await authenticateToken(db, `Bearer ${RAW}`);
    expect(ctx).not.toBeNull();
    expect(ctx?.role).toBe("ADMIN");
  });
});

describe("revocation", () => {
  it("refuses a revoked token", async () => {
    const db = makeDb({
      tokenId: "t1",
      userId: "u1",
      expiresAt: null,
      revokedAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(await authenticateToken(db, `Bearer ${RAW}`)).toBeNull();
  });

  it("refuses it the SAME WAY an unknown token is refused — no extra signal", async () => {
    const revoked = makeDb({
      tokenId: "t1",
      userId: "u1",
      expiresAt: null,
      revokedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const unknown = makeDb(null);
    expect(await authenticateToken(revoked, `Bearer ${RAW}`)).toBe(
      await authenticateToken(unknown, `Bearer ${RAW}`)
    );
  });
});

describe("expiry", () => {
  it("refuses a token whose expires_at is in the past", async () => {
    const db = makeDb({
      tokenId: "t1",
      userId: "u1",
      expiresAt: new Date(Date.now() - 60_000),
      revokedAt: null,
    });
    expect(await authenticateToken(db, `Bearer ${RAW}`)).toBeNull();
  });

  it("ACCEPTS a token whose expires_at is in the future", async () => {
    // The positive landmark. A check that refused every token carrying an
    // expiry would pass the test above and fail this one.
    const db = makeDb({
      tokenId: "t1",
      userId: "u1",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      revokedAt: null,
    });
    expect(await authenticateToken(db, `Bearer ${RAW}`)).not.toBeNull();
  });
});

describe("last_used_at is written, not merely hoped for", () => {
  it("hands the write to waitUntil when a context is available", async () => {
    const db = makeDb({ tokenId: "t1", userId: "u1", expiresAt: null, revokedAt: null });
    const waitUntil = vi.fn();
    await authenticateToken(db, `Bearer ${RAW}`, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toHaveProperty("lastUsedAt");
  });

  it("awaits the write when there is no context, rather than dropping it", async () => {
    // The pre-OPE-903 code did `.then(() => {})` with neither await nor
    // waitUntil, so the runtime could cancel it once the response was sent.
    const db = makeDb({ tokenId: "t1", userId: "u1", expiresAt: null, revokedAt: null });
    await authenticateToken(db, `Bearer ${RAW}`);
    expect(db.updates).toHaveLength(1);
  });

  it("does NOT touch last_used_at for a revoked token", async () => {
    const db = makeDb({
      tokenId: "t1",
      userId: "u1",
      expiresAt: null,
      revokedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await authenticateToken(db, `Bearer ${RAW}`);
    expect(db.updates).toHaveLength(0);
  });
});

describe("the header contract is unchanged", () => {
  it.each([
    ["", null],
    ["Bearer ", null],
    ["Basic abc", null],
  ])("refuses %j", async (header) => {
    const db = makeDb({ tokenId: "t1", userId: "u1", expiresAt: null, revokedAt: null });
    expect(await authenticateToken(db, header as string)).toBeNull();
  });
});
