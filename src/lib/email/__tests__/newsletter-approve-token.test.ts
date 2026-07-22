import { describe, expect, it } from "vitest";
import {
  APPROVE_TOKEN_TTL_MS,
  resolveApproveSecret,
  signApproveToken,
  verifyApproveToken,
} from "../newsletter-approve-token";
import { signUnsubscribeToken } from "../newsletter-unsubscribe-token";

const SECRET = "test-secret-abc123";
const NOW = new Date("2026-07-21T00:00:00.000Z");

describe("newsletter approve token", () => {
  it("round-trips a slug and returns its claims", async () => {
    const token = await signApproveToken("weekend-fair-digest-2026-07-25", SECRET, NOW);
    const claims = await verifyApproveToken(token, SECRET, NOW);
    expect(claims?.slug).toBe("weekend-fair-digest-2026-07-25");
    expect(claims?.exp).toBe(NOW.getTime() + APPROVE_TOKEN_TTL_MS);
  });

  it("rejects a tampered payload", async () => {
    const token = await signApproveToken("issue-a", SECRET, NOW);
    const [payload, sig] = token.split(".");
    // Swap in a different slug's payload while keeping the original signature.
    const other = await signApproveToken("issue-b", SECRET, NOW);
    const forged = `${other.split(".")[0]}.${sig}`;
    expect(forged).not.toBe(token);
    expect(await verifyApproveToken(forged, SECRET, NOW)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signApproveToken("issue-a", SECRET, NOW);
    expect(await verifyApproveToken(token, "other-secret", NOW)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signApproveToken("issue-a", SECRET, NOW);
    const afterExpiry = new Date(NOW.getTime() + APPROVE_TOKEN_TTL_MS + 1);
    expect(await verifyApproveToken(token, SECRET, afterExpiry)).toBeNull();
  });

  it("accepts a token right up to the expiry boundary", async () => {
    const token = await signApproveToken("issue-a", SECRET, NOW);
    const justBefore = new Date(NOW.getTime() + APPROVE_TOKEN_TTL_MS - 1);
    expect((await verifyApproveToken(token, SECRET, justBefore))?.slug).toBe("issue-a");
  });

  it("rejects malformed tokens without throwing", async () => {
    for (const bad of ["", "no-dot", ".", "a.", ".b", "not.base64.here"]) {
      expect(await verifyApproveToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("does NOT accept an unsubscribe token (domain separation)", async () => {
    // Both schemes may share AUTH_SECRET; an unsubscribe token must never verify
    // as an approve token even under the same key.
    const unsub = await signUnsubscribeToken("someone@example.com", SECRET);
    expect(await verifyApproveToken(unsub, SECRET, NOW)).toBeNull();
  });

  it("resolveApproveSecret prefers the dedicated secret, then AUTH_SECRET", () => {
    expect(resolveApproveSecret({ NEWSLETTER_APPROVE_SECRET: "a", AUTH_SECRET: "b" })).toBe("a");
    expect(resolveApproveSecret({ AUTH_SECRET: "b" })).toBe("b");
    expect(resolveApproveSecret({ NEXTAUTH_SECRET: "c" })).toBe("c");
    expect(resolveApproveSecret({})).toBeUndefined();
  });
});
