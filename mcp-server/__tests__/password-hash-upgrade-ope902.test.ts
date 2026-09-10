/**
 * OPE-902 — legacy unsalted SHA-256 password hashes are upgraded on use.
 *
 * `verifySha256` accepted a bare SHA-256 digest of the password, with no salt
 * and no work factor, and nothing ever rewrote those rows — so an account
 * minted under the old scheme stayed unsalted for as long as it existed. The
 * upgrade runs only after the legacy hash has already verified, so it cannot
 * lock anyone out.
 */
import { describe, it, expect } from "vitest";
import { verifyPassword, isLegacyPasswordHash, hashPasswordPbkdf2 } from "../src/oauth/utils.js";

const PASSWORD = "correct-horse-battery-staple";

/** The legacy format: a bare hex SHA-256 of the password, no salt, no colon. */
async function legacySha256(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("telling the two hash formats apart", () => {
  it("classifies a bare digest as legacy", async () => {
    const legacy = await legacySha256(PASSWORD);
    expect(legacy).not.toContain(":");
    expect(isLegacyPasswordHash(legacy)).toBe(true);
  });

  it("classifies a salted PBKDF2 hash as NOT legacy", async () => {
    const modern = await hashPasswordPbkdf2(PASSWORD);
    expect(modern).toContain(":");
    expect(isLegacyPasswordHash(modern)).toBe(false);
  });
});

describe("both formats still verify — the upgrade must not lock anyone out", () => {
  it("accepts the correct password against a legacy hash", async () => {
    expect(await verifyPassword(PASSWORD, await legacySha256(PASSWORD))).toBe(true);
  });

  it("accepts the correct password against a freshly minted PBKDF2 hash", async () => {
    // The round-trip that matters: whatever `upgradePasswordHash` writes must
    // be readable by `verifyPbkdf2`, or the upgrade would silently lock the
    // account on the NEXT login rather than this one.
    expect(await verifyPassword(PASSWORD, await hashPasswordPbkdf2(PASSWORD))).toBe(true);
  });

  it("rejects a wrong password in both formats", async () => {
    expect(await verifyPassword("wrong", await legacySha256(PASSWORD))).toBe(false);
    expect(await verifyPassword("wrong", await hashPasswordPbkdf2(PASSWORD))).toBe(false);
  });
});

describe("the new hash is actually salted", () => {
  it("produces a different hash each time for the same password", async () => {
    const a = await hashPasswordPbkdf2(PASSWORD);
    const b = await hashPasswordPbkdf2(PASSWORD);
    // Unsalted hashing is exactly what this ticket is replacing; if these two
    // matched, the "upgrade" would have re-introduced the defect.
    expect(a).not.toBe(b);
    expect(a.split(":")[0]).not.toBe(b.split(":")[0]);
    // ...and both must still verify, so the difference is salt, not damage.
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it("uses a 16-byte salt", async () => {
    const [saltHex] = (await hashPasswordPbkdf2(PASSWORD)).split(":");
    expect(saltHex).toHaveLength(32);
  });
});
