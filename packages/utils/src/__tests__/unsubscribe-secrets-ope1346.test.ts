/**
 * OPE-1346 — signing and verifying are separate questions.
 *
 * SIGN with UNSUBSCRIBE_SECRET, else INTERNAL_API_KEY; never `_PREVIOUS`.
 * VERIFY against every accepted secret, so introducing UNSUBSCRIBE_SECRET (or
 * rotating INTERNAL_API_KEY after the window) never breaks a delivered link.
 */
import { describe, expect, it } from "vitest";
import {
  buildUnsubscribeUrl,
  computeUnsubscribeToken,
  openUnsubscribeEmailAny,
  unsubscribeSigningSecret,
  unsubscribeVerifySecrets,
  verifySealedUnsubscribeAny,
  verifyUnsubscribeTokenAny,
} from "../email-unsubscribe";

const INTERNAL = "internal-key-0123456789";
const DEDICATED = "dedicated-unsub-key-abcdef";
const PREVIOUS = "previous-unsub-key-zyxw";
const EMAIL = "Organizer@Example.com";

const sealedOf = async (secret: string) =>
  (await buildUnsubscribeUrl("https://meetmeatthefair.com", secret, EMAIL)).split("/v2/")[1];

describe("unsubscribeSigningSecret (OPE-1346)", () => {
  it("signs with UNSUBSCRIBE_SECRET when set, else INTERNAL_API_KEY", () => {
    expect(unsubscribeSigningSecret({ INTERNAL_API_KEY: INTERNAL })).toBe(INTERNAL);
    expect(
      unsubscribeSigningSecret({ INTERNAL_API_KEY: INTERNAL, UNSUBSCRIBE_SECRET: DEDICATED })
    ).toBe(DEDICATED);
  });

  it("NEVER signs with _PREVIOUS — a retired key must not mint new links", () => {
    expect(unsubscribeSigningSecret({ UNSUBSCRIBE_SECRET_PREVIOUS: PREVIOUS })).toBe("");
    expect(
      unsubscribeSigningSecret({
        INTERNAL_API_KEY: INTERNAL,
        UNSUBSCRIBE_SECRET_PREVIOUS: PREVIOUS,
      })
    ).toBe(INTERNAL);
  });
});

describe("unsubscribeVerifySecrets (OPE-1346)", () => {
  it("is the ordered, deduplicated, non-empty list", () => {
    expect(
      unsubscribeVerifySecrets({
        UNSUBSCRIBE_SECRET: DEDICATED,
        INTERNAL_API_KEY: INTERNAL,
        UNSUBSCRIBE_SECRET_PREVIOUS: PREVIOUS,
      })
    ).toEqual([DEDICATED, INTERNAL, PREVIOUS]);
    expect(
      unsubscribeVerifySecrets({ UNSUBSCRIBE_SECRET: INTERNAL, INTERNAL_API_KEY: INTERNAL })
    ).toEqual([INTERNAL]);
    expect(
      unsubscribeVerifySecrets({ UNSUBSCRIBE_SECRET: "", INTERNAL_API_KEY: INTERNAL })
    ).toEqual([INTERNAL]);
  });

  it("the retire switch drops INTERNAL_API_KEY — but only once a dedicated key exists to sign", () => {
    expect(
      unsubscribeVerifySecrets({
        UNSUBSCRIBE_SECRET: DEDICATED,
        INTERNAL_API_KEY: INTERNAL,
        UNSUBSCRIBE_RETIRE_INTERNAL_KEY: "1",
      })
    ).toEqual([DEDICATED]);
    // Without UNSUBSCRIBE_SECRET the internal key IS the signer; retiring it
    // would verify nothing, so the switch is ignored.
    expect(
      unsubscribeVerifySecrets({ INTERNAL_API_KEY: INTERNAL, UNSUBSCRIBE_RETIRE_INTERNAL_KEY: "1" })
    ).toEqual([INTERNAL]);
  });
});

describe("a delivered link survives the transition (OPE-1346)", () => {
  const before = { INTERNAL_API_KEY: INTERNAL };
  const after = { INTERNAL_API_KEY: INTERNAL, UNSUBSCRIBE_SECRET: DEDICATED };

  it.each([
    ["UNSUBSCRIBE_SECRET", DEDICATED],
    ["INTERNAL_API_KEY", INTERNAL],
    ["UNSUBSCRIBE_SECRET_PREVIOUS", PREVIOUS],
  ])("a legacy HMAC token signed with %s verifies", async (_name, secret) => {
    const all = unsubscribeVerifySecrets({ ...after, UNSUBSCRIBE_SECRET_PREVIOUS: PREVIOUS });
    const token = await computeUnsubscribeToken(secret, EMAIL);
    expect(await verifyUnsubscribeTokenAny(all, EMAIL, token)).toBe(true);
  });

  it("a token signed with an unknown secret is refused", async () => {
    const token = await computeUnsubscribeToken("not-a-key-we-hold", EMAIL);
    expect(await verifyUnsubscribeTokenAny(unsubscribeVerifySecrets(after), EMAIL, token)).toBe(
      false
    );
  });

  it("a sealed (v2) link signed BEFORE UNSUBSCRIBE_SECRET existed still opens AFTER it is set", async () => {
    const sealed = await sealedOf(unsubscribeSigningSecret(before)); // signed with INTERNAL
    const secrets = unsubscribeVerifySecrets(after);
    expect(secrets[0]).toBe(DEDICATED); // landmark: the dedicated key is tried FIRST, and fails
    expect(await openUnsubscribeEmailAny(secrets, sealed)).toBe(EMAIL.toLowerCase());
    expect(await verifySealedUnsubscribeAny(secrets, EMAIL, sealed)).toBe(true);
  });

  it("…and stops opening once the internal key is retired (runbook step c)", async () => {
    const sealed = await sealedOf(INTERNAL);
    const retired = unsubscribeVerifySecrets({ ...after, UNSUBSCRIBE_RETIRE_INTERNAL_KEY: "1" });
    expect(await openUnsubscribeEmailAny(retired, sealed)).toBeNull();
  });

  it("a sealed link signed with an unknown secret is refused", async () => {
    const sealed = await sealedOf("not-a-key-we-hold");
    expect(await verifySealedUnsubscribeAny(unsubscribeVerifySecrets(after), EMAIL, sealed)).toBe(
      false
    );
  });
});
