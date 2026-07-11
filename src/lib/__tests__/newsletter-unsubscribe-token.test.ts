/**
 * OPE-169 — stateless one-click unsubscribe token. A valid token round-trips to
 * the (normalized) email; tampering with the signature, the payload, or the
 * secret all fail closed. No DB — pure HMAC over the email.
 */
import { describe, it, expect } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../email/newsletter-unsubscribe-token";

const SECRET = "test-signing-secret-0123456789";

describe("newsletter unsubscribe token (OPE-169)", () => {
  it("round-trips a signed token back to the email", async () => {
    const token = await signUnsubscribeToken("Carol@Example.com", SECRET);
    expect(token).toContain(".");
    // Email is normalized (trim + lowercase) before signing.
    expect(await verifyUnsubscribeToken(token, SECRET)).toBe("carol@example.com");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signUnsubscribeToken("a@example.com", SECRET);
    expect(await verifyUnsubscribeToken(token, "some-other-secret")).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signUnsubscribeToken("a@example.com", SECRET);
    const [payload] = token.split(".");
    expect(await verifyUnsubscribeToken(`${payload}.deadbeef`, SECRET)).toBeNull();
  });

  it("rejects a swapped payload (can't forge a different address onto a signature)", async () => {
    const good = await signUnsubscribeToken("victim@example.com", SECRET);
    const attacker = await signUnsubscribeToken("attacker@example.com", SECRET);
    const forged = `${good.split(".")[0]}.${attacker.split(".")[1]}`;
    expect(await verifyUnsubscribeToken(forged, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyUnsubscribeToken("", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken("nodot", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken(".", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken("payload.", SECRET)).toBeNull();
  });
});
