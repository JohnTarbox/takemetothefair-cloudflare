/**
 * OPE-864 — unsubscribe links carry the address SEALED, not base64'd.
 *
 * The reviewer decoded `am9obkBwaW1ib2F0LmNvbXx3ZWVrZW5k` out of a live footer
 * link to `john@pimboat.com|weekend`. These pin that a new link hides the
 * address, still round-trips to exactly that recipient, and cannot be edited.
 */
import { describe, it, expect } from "vitest";
import { sealClaim, openClaim } from "../unsubscribe-seal";
import {
  base64UrlEncode,
  buildUnsubscribeUrl,
  computeUnsubscribeToken,
  openUnsubscribeEmail,
  verifySealedUnsubscribe,
  verifyUnsubscribeToken,
} from "../email-unsubscribe";

const SECRET = "test-secret-0123456789";

describe("sealClaim / openClaim", () => {
  it("round-trips, and the output contains no readable claim", async () => {
    const sealed = await sealClaim(SECRET, "john@pimboat.com|vendor");
    expect(sealed).not.toContain("pimboat");
    expect(sealed).not.toContain(base64UrlEncode("john@pimboat.com").slice(0, 12));
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no `=` (QP-safe)
    expect(await openClaim(SECRET, sealed)).toBe("john@pimboat.com|vendor");
  });

  it("a random IV — two seals of one claim differ, both open", async () => {
    const a = await sealClaim(SECRET, "a@b.co");
    const b = await sealClaim(SECRET, "a@b.co");
    expect(a).not.toBe(b);
    expect(await openClaim(SECRET, a)).toBe("a@b.co");
    expect(await openClaim(SECRET, b)).toBe("a@b.co");
  });

  it("any edit, a wrong secret, or truncation fails closed", async () => {
    const sealed = await sealClaim(SECRET, "a@b.co");
    const i = Math.floor(sealed.length / 2);
    const edited = `${sealed.slice(0, i)}${sealed[i] === "A" ? "B" : "A"}${sealed.slice(i + 1)}`;
    expect(await openClaim(SECRET, edited)).toBeNull();
    expect(await openClaim("another-secret", sealed)).toBeNull();
    expect(await openClaim(SECRET, sealed.slice(0, 20))).toBeNull();
    expect(await openClaim(SECRET, "")).toBeNull();
    expect(await openClaim("", sealed)).toBeNull();
  });
});

describe("Path B — /unsubscribe/v2/<sealed>", () => {
  it("builds a link with no readable address that opens to the recipient", async () => {
    const url = await buildUnsubscribeUrl(
      "https://meetmeatthefair.com/",
      SECRET,
      " Owner@Acme.TEST "
    );
    const m = url.match(/^https:\/\/meetmeatthefair\.com\/unsubscribe\/v2\/([A-Za-z0-9_-]+)$/);
    expect(m).not.toBeNull();
    expect(url).not.toContain(base64UrlEncode("owner@acme.test"));
    expect(await openUnsubscribeEmail(SECRET, m![1])).toBe("owner@acme.test");
    expect(await verifySealedUnsubscribe(SECRET, "owner@acme.test", m![1])).toBe(true);
    expect(await verifySealedUnsubscribe(SECRET, "someone@else.test", m![1])).toBe(false);
  });

  it("a sealed non-email claim is rejected", async () => {
    const sealed = await sealClaim(SECRET, "not-an-address");
    expect(await openUnsubscribeEmail(SECRET, sealed)).toBeNull();
  });

  it("the LEGACY hex HMAC form still verifies (links already delivered)", async () => {
    const token = await computeUnsubscribeToken(SECRET, "owner@acme.test");
    expect(await verifyUnsubscribeToken(SECRET, "owner@acme.test", token)).toBe(true);
  });
});
