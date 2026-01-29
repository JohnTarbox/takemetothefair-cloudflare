import { describe, it, expect } from "vitest";

// Test PBKDF2 password hashing (mirrors src/lib/auth.ts implementation)
const PBKDF2_ITERATIONS = 100_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${toHex(salt.buffer)}:${toHex(derivedBits)}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.includes(":")) return false;
  const [saltHex, hashHex] = storedHash.split(":");
  const encoder = new TextEncoder();
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(derivedBits) === hashHex;
}

describe("hashPassword", () => {
  it("hashes a password in salt:hash format", async () => {
    const hash = await hashPassword("testPassword123");
    expect(hash).toContain(":");
    const [salt, derived] = hash.split(":");
    expect(salt.length).toBe(32); // 16 bytes = 32 hex
    expect(derived.length).toBe(64); // 32 bytes = 64 hex
  });

  it("generates different hashes for same password (random salt)", async () => {
    const hash1 = await hashPassword("testPassword123");
    const hash2 = await hashPassword("testPassword123");
    expect(hash1).not.toBe(hash2);
  });

  it("generates different hashes for different passwords", async () => {
    const hash1 = await hashPassword("password1");
    const hash2 = await hashPassword("password2");
    expect(hash1).not.toBe(hash2);
  });
});

describe("verifyPassword", () => {
  it("returns true for correct password", async () => {
    const hash = await hashPassword("testPassword123");
    expect(await verifyPassword("testPassword123", hash)).toBe(true);
  });

  it("returns false for incorrect password", async () => {
    const hash = await hashPassword("testPassword123");
    expect(await verifyPassword("wrongPassword456", hash)).toBe(false);
  });

  it("returns false for empty password against valid hash", async () => {
    const hash = await hashPassword("testPassword123");
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("handles special characters in password", async () => {
    const password = "Test@Pass#123!$%^&*()";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it("handles unicode characters in password", async () => {
    const password = "Test密码123";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it("is case sensitive", async () => {
    const hash = await hashPassword("TestPassword");
    expect(await verifyPassword("testpassword", hash)).toBe(false);
  });
});
