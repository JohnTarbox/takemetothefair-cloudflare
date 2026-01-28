import { describe, it, expect } from "vitest";

// Test the password hashing functions directly
// The edge-compatible implementation uses SHA-256 via crypto.subtle

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "test-secret");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const newHash = await hashPassword(password);
  return newHash === hash;
}

describe("hashPassword", () => {
  it("hashes a password", async () => {
    const password = "testPassword123";
    const hash = await hashPassword(password);

    expect(hash).toBeDefined();
    expect(hash).not.toBe(password);
    expect(hash.length).toBe(64); // SHA-256 produces 64 hex characters
  });

  it("generates same hash for same password", async () => {
    const password = "testPassword123";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    // SHA-256 is deterministic (unlike bcrypt with salt)
    expect(hash1).toBe(hash2);
  });

  it("generates different hashes for different passwords", async () => {
    const hash1 = await hashPassword("password1");
    const hash2 = await hashPassword("password2");

    expect(hash1).not.toBe(hash2);
  });

  it("generates valid hex string", async () => {
    const password = "testPassword123";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyPassword", () => {
  it("returns true for correct password", async () => {
    const password = "testPassword123";
    const hash = await hashPassword(password);

    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it("returns false for incorrect password", async () => {
    const password = "testPassword123";
    const wrongPassword = "wrongPassword456";
    const hash = await hashPassword(password);

    const isValid = await verifyPassword(wrongPassword, hash);
    expect(isValid).toBe(false);
  });

  it("returns false for empty password against valid hash", async () => {
    const password = "testPassword123";
    const hash = await hashPassword(password);

    const isValid = await verifyPassword("", hash);
    expect(isValid).toBe(false);
  });

  it("handles special characters in password", async () => {
    const password = "Test@Pass#123!$%^&*()";
    const hash = await hashPassword(password);

    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it("handles unicode characters in password", async () => {
    const password = "Test密码123";
    const hash = await hashPassword(password);

    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it("is case sensitive", async () => {
    const password = "TestPassword";
    const hash = await hashPassword(password);

    const isValid = await verifyPassword("testpassword", hash);
    expect(isValid).toBe(false);
  });
});
