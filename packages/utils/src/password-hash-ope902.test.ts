/**
 * OPE-902 — the one PBKDF2 hash format and constant-time verifier both Workers
 * use. Legacy unsalted SHA-256 digests are refused: 0 of 177 password rows used
 * them on prod (2026-09-16), and the two Workers' legacy copies had drifted.
 */
import { describe, expect, it, vi } from "vitest";

const compared: Array<[string | null | undefined, string | null | undefined]> = [];
vi.mock("./timing-safe-equal", async (orig) => {
  const real = await orig<typeof import("./timing-safe-equal")>();
  return {
    ...real,
    timingSafeEqualString: vi.fn(async (a: string, b: string) => {
      compared.push([a, b]);
      return real.timingSafeEqualString(a, b);
    }),
  };
});

import { PBKDF2_ITERATIONS, hashPasswordPbkdf2, verifyPasswordHash } from "./password-hash";

const PASSWORD = "correct-horse-battery-staple";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("hashPasswordPbkdf2", () => {
  it("mints <32 hex salt>:<64 hex digest> with a fresh salt each time", async () => {
    const a = await hashPasswordPbkdf2(PASSWORD);
    const b = await hashPasswordPbkdf2(PASSWORD);
    expect(a).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("uses 100k iterations — the value every stored prod hash was minted with", () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
  });
});

describe("verifyPasswordHash", () => {
  it("accepts the right password and refuses a wrong one", async () => {
    const stored = await hashPasswordPbkdf2(PASSWORD);
    expect(await verifyPasswordHash(PASSWORD, stored)).toBe(true);
    expect(await verifyPasswordHash("wrong", stored)).toBe(false);
  });

  it("compares the digest through the constant-time comparator, not ===", async () => {
    const stored = await hashPasswordPbkdf2(PASSWORD);
    compared.length = 0;
    await verifyPasswordHash(PASSWORD, stored);
    // Positive landmark AND the guard: exactly one comparison, of the stored digest.
    expect(compared).toHaveLength(1);
    expect(compared[0][1]).toBe(stored.split(":")[1]);
  });

  it("refuses BOTH legacy digest shapes the two Workers used to accept", async () => {
    // MCP Worker's old legacy branch: sha256(password)
    expect(await verifyPasswordHash(PASSWORD, await sha256Hex(PASSWORD))).toBe(false);
    // Main app's old legacy branch: sha256(password + AUTH_SECRET)
    expect(await verifyPasswordHash(PASSWORD, await sha256Hex(PASSWORD + "fallback-secret"))).toBe(
      false
    );
  });

  it.each([
    ["empty", ""],
    ["null", null],
    ["no digest", "aabb:"],
    ["no salt", ":aabb"],
    ["three parts", "aa:bb:cc"],
    ["non-hex salt", "zz:aabb"],
    ["odd-length hex", "abc:aabb"],
  ])("refuses a malformed stored hash (%s)", async (_label, stored) => {
    expect(await verifyPasswordHash(PASSWORD, stored as string | null)).toBe(false);
  });

  it("refuses an empty password even against a real hash", async () => {
    expect(await verifyPasswordHash("", await hashPasswordPbkdf2(""))).toBe(false);
  });
});
