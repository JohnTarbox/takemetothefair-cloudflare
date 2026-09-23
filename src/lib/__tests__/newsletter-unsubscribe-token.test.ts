/**
 * OPE-169 — stateless one-click unsubscribe token. A valid token round-trips to
 * the (normalized) email; tampering with the signature, the payload, or the
 * secret all fail closed. No DB — pure HMAC over the email.
 */
import { describe, it, expect } from "vitest";
import {
  signLegacyUnsubscribeToken,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../email/newsletter-unsubscribe-token";

const SECRET = "test-signing-secret-0123456789";

describe("newsletter unsubscribe token (OPE-169)", () => {
  it("round-trips a signed token back to the email", async () => {
    const token = await signUnsubscribeToken("Carol@Example.com", SECRET);
    expect(token).toContain(".");
    // Email is normalized (trim + lowercase) before signing.
    // OPE-864 — the verifier now returns claims rather than a bare string, so
    // the LIST can travel inside the signature. A token signed with no list
    // (this one) still means "every list", which is what every link already in
    // someone's inbox depends on.
    expect(await verifyUnsubscribeToken(token, SECRET)).toEqual({
      email: "carol@example.com",
      list: null,
    });
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

  it("rejects a tampered sealed token (the address can't be edited in transit)", async () => {
    const good = await signUnsubscribeToken("victim@example.com", SECRET);
    expect(good.startsWith("v2.")).toBe(true);
    const body = good.slice(3);
    const i = Math.floor(body.length / 2);
    const tampered = `v2.${body.slice(0, i)}${body[i] === "A" ? "B" : "A"}${body.slice(i + 1)}`;
    expect(await verifyUnsubscribeToken(tampered, SECRET)).toBeNull();
  });

  it("OPE-864 — the token carries no readable address", async () => {
    const tok = await signUnsubscribeToken("john@pimboat.com", SECRET, "weekend");
    const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(tok).not.toContain(b64("john@pimboat.com").slice(0, 12));
    expect(tok).not.toContain("pimboat");
    expect(await verifyUnsubscribeToken(tok, SECRET)).toEqual({
      email: "john@pimboat.com",
      list: "weekend",
    });
  });

  it("a sealed token made with another secret does not open", async () => {
    const tok = await signUnsubscribeToken("a@b.co", "other-secret");
    expect(await verifyUnsubscribeToken(tok, SECRET)).toBeNull();
  });

  it("LEGACY tokens already in inboxes still verify — and still resist a swapped payload", async () => {
    const legacy = await signLegacyUnsubscribeToken("victim@example.com", SECRET, "vendor");
    expect(await verifyUnsubscribeToken(legacy, SECRET)).toEqual({
      email: "victim@example.com",
      list: "vendor",
    });
    const attacker = await signLegacyUnsubscribeToken("attacker@example.com", SECRET);
    const forged = `${legacy.split(".")[0]}.${attacker.split(".")[1]}`;
    expect(await verifyUnsubscribeToken(forged, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyUnsubscribeToken("", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken("nodot", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken(".", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken("payload.", SECRET)).toBeNull();
  });
});
