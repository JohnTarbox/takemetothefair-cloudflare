/**
 * OPE-944 — DKIM verification, proven against a REAL signature.
 *
 * These tests generate an RSA keypair, sign a message with it exactly as a
 * sending MTA would, publish the public half through a stub resolver, and then
 * verify. That round-trip is the point: a verifier tested only against
 * hand-written fixtures proves it can parse a string, not that it can tell a
 * genuine signature from a forged one.
 *
 * The tamper cases are the acceptance criterion from the ticket — "Tampering
 * one byte of the stored body flips it to failed".
 */
import { describe, expect, it } from "vitest";
import {
  canonicalizeBody,
  canonicalizeHeader,
  domainsAlign,
  extractAddress,
  parseHeaderLines,
  parseTagList,
  splitMessage,
  verifyDkim,
  type TxtResolver,
} from "../src/email-handlers/dkim-verify.js";

const CRLF = "\r\n";

function b64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

/**
 * Sign a message the way a real MTA does. Mirrors RFC 6376 §3.7 rather than
 * reusing the verifier's own internals — a signer built out of the verifier's
 * helpers would agree with it even if both were wrong about the RFC.
 */
async function signMessage(opts: {
  headers: Array<[string, string]>;
  body: string;
  domain: string;
  selector: string;
  signedHeaders: string[];
  canon?: "relaxed/relaxed" | "simple/simple";
}): Promise<{ raw: string; publicKeyB64: string }> {
  const canon = opts.canon ?? "relaxed/relaxed";
  const [hMode, bMode] = canon.split("/") as Array<"relaxed" | "simple">;

  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const publicKeyB64 = b64(await crypto.subtle.exportKey("spki", pair.publicKey));

  const enc = new TextEncoder();
  const canonBody = canonicalizeBody(opts.body, bMode);
  const bh = b64(await crypto.subtle.digest("SHA-256", enc.encode(canonBody)));

  const headerLines = opts.headers.map(([k, v]) => `${k}: ${v}`);
  const findHeader = (name: string) =>
    headerLines.find((l) => l.slice(0, l.indexOf(":")).trim().toLowerCase() === name.toLowerCase());

  const sigBase =
    `DKIM-Signature: v=1; a=rsa-sha256; c=${canon}; d=${opts.domain}; s=${opts.selector}; ` +
    `h=${opts.signedHeaders.join(":")}; bh=${bh}; b=`;

  const parts = opts.signedHeaders
    .map((n) => findHeader(n))
    .filter((l): l is string => Boolean(l))
    .map((l) => canonicalizeHeader(l, hMode));
  parts.push(canonicalizeHeader(sigBase, hMode));

  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    pair.privateKey,
    enc.encode(parts.join(CRLF))
  );

  const raw = [`${sigBase}${b64(sig)}`, ...headerLines, "", opts.body].join(CRLF);
  return { raw, publicKeyB64 };
}

const stubResolver = (p: string, k = "rsa"): TxtResolver => {
  return async () => [`v=DKIM1; k=${k}; p=${p}`];
};

const ORGANIZER_HEADERS: Array<[string, string]> = [
  ["From", "Sarah Rodriguez <recdirector@newgloucester.com>"],
  ["To", "Sarah Rodriguez <recdirector@newgloucester.com>"],
  ["Subject", "New Gloucester Community Fair - Information"],
  ["Date", "Thu, 10 Sep 2026 12:04:00 -0400"],
];
const ORGANIZER_BODY =
  "NEW GLOUCESTER COMMUNITY FAIR\r\nabout 70 vendors, crafters, community groups\r\n9:00 AM-3:00 PM\r\n";

describe("OPE-944 — a genuine signature verifies", () => {
  it("verifies a real RSA-SHA256 signature and reports the signing domain", async () => {
    const { raw, publicKeyB64 } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "sel1",
      signedHeaders: ["from", "to", "subject", "date"],
    });

    const r = await verifyDkim(raw, stubResolver(publicKeyB64));
    expect(r.verdict).toBe("verified");
    expect(r.domain).toBe("newgloucester.com");
    expect(r.selector).toBe("sel1");
    expect(r.fromAddress).toBe("recdirector@newgloucester.com");
    expect(r.alignedWithFrom).toBe(true);
  });

  it("verifies under simple/simple canonicalization too", async () => {
    const { raw, publicKeyB64 } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "sel1",
      signedHeaders: ["from", "subject"],
      canon: "simple/simple",
    });
    expect((await verifyDkim(raw, stubResolver(publicKeyB64))).verdict).toBe("verified");
  });
});

describe("OPE-944 — tampering flips the verdict (the ticket's acceptance)", () => {
  it("ONE byte changed in the body → failed, with a body-hash reason", async () => {
    const { raw, publicKeyB64 } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "sel1",
      signedHeaders: ["from", "to", "subject", "date"],
    });

    // 70 vendors → 80 vendors. Exactly one byte.
    const tampered = raw.replace("about 70 vendors", "about 80 vendors");
    expect(tampered).not.toBe(raw);
    expect(tampered.length).toBe(raw.length);

    const r = await verifyDkim(tampered, stubResolver(publicKeyB64));
    expect(r.verdict).toBe("failed");
    expect(r.detail).toMatch(/body hash mismatch/);
  });

  it("a changed SIGNED HEADER → failed, and it is NOT caught by the body hash", async () => {
    const { raw, publicKeyB64 } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "sel1",
      signedHeaders: ["from", "to", "subject", "date"],
    });
    // Re-point the From at an impostor. The body is untouched, so this can only
    // be caught by the signature check — which is the half that needs the key.
    const tampered = raw.replace("recdirector@newgloucester.com>", "impostor@example.net>");

    const r = await verifyDkim(tampered, stubResolver(publicKeyB64));
    expect(r.verdict).toBe("failed");
    expect(r.detail).toMatch(/did not validate/);
    expect(r.detail).not.toMatch(/body hash/);
  });

  it("a DIFFERENT domain's key → failed", async () => {
    const { raw } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "sel1",
      signedHeaders: ["from", "subject"],
    });
    // An attacker's own perfectly valid key, published at the victim's selector.
    const other = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "evil.example",
      selector: "sel1",
      signedHeaders: ["from", "subject"],
    });
    expect((await verifyDkim(raw, stubResolver(other.publicKeyB64))).verdict).toBe("failed");
  });
});

describe("OPE-944 — the verdicts that are NOT failures", () => {
  it("no DKIM-Signature at all → no_signature, not failed", async () => {
    const raw = [
      "From: Sarah Rodriguez <recdirector@newgloucester.com>",
      "Subject: unsigned",
      "",
      "body",
    ].join(CRLF);
    const r = await verifyDkim(raw, stubResolver("unused"));
    expect(r.verdict).toBe("no_signature");
    expect(r.fromAddress).toBe("recdirector@newgloucester.com");
  });

  it("DNS does not answer → key_unavailable, NOT failed (rotated selector)", async () => {
    const { raw } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "retired",
      signedHeaders: ["from", "subject"],
    });
    const r = await verifyDkim(raw, async () => {
      throw new Error("NXDOMAIN");
    });
    expect(r.verdict).toBe("key_unavailable");
    expect(r.detail).toMatch(/DNS lookup failed/);
  });

  it("an empty TXT answer → key_unavailable", async () => {
    const { raw } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "gone",
      signedHeaders: ["from", "subject"],
    });
    expect((await verifyDkim(raw, async () => [])).verdict).toBe("key_unavailable");
  });

  it("an explicitly REVOKED key (empty p=) → failed, not key_unavailable", async () => {
    const { raw } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "newgloucester.com",
      selector: "sel1",
      signedHeaders: ["from", "subject"],
    });
    const r = await verifyDkim(raw, async () => ["v=DKIM1; k=rsa; p="]);
    expect(r.verdict).toBe("failed");
    expect(r.detail).toMatch(/revoked/);
  });

  it("a valid signature from an UNALIGNED domain verifies but is not aligned", async () => {
    // What a mailing list or an ESP produces. Real, and not the organizer
    // vouching for the content — so the two facts stay separate.
    const { raw, publicKeyB64 } = await signMessage({
      headers: ORGANIZER_HEADERS,
      body: ORGANIZER_BODY,
      domain: "mailinglist.example",
      selector: "sel1",
      signedHeaders: ["from", "subject"],
    });
    const r = await verifyDkim(raw, stubResolver(publicKeyB64));
    expect(r.verdict).toBe("verified");
    expect(r.alignedWithFrom).toBe(false);
  });

  it("a subdomain signature IS aligned (relaxed alignment)", async () => {
    const { raw, publicKeyB64 } = await signMessage({
      headers: [
        ["From", "Sarah <recdirector@mail.newgloucester.com>"],
        ["Subject", "s"],
      ],
      body: "b\r\n",
      domain: "newgloucester.com",
      selector: "sel1",
      signedHeaders: ["from", "subject"],
    });
    const r = await verifyDkim(raw, stubResolver(publicKeyB64));
    expect(r.verdict).toBe("verified");
    expect(r.alignedWithFrom).toBe(true);
  });
});

describe("OPE-944 — canonicalization units (RFC 6376)", () => {
  it("relaxed header: lowercases the name, unfolds, collapses WSP", () => {
    expect(canonicalizeHeader("Subject:  New   Gloucester\r\n  Fair ", "relaxed")).toBe(
      "subject:New Gloucester Fair"
    );
  });

  it("simple header leaves the line untouched", () => {
    expect(canonicalizeHeader("Subject:  Spaced  ", "simple")).toBe("Subject:  Spaced  ");
  });

  it("both body modes strip trailing empty lines and end in exactly one CRLF", () => {
    expect(canonicalizeBody("a\r\nb\r\n\r\n\r\n", "simple")).toBe("a\r\nb\r\n");
    expect(canonicalizeBody("a \r\nb\t\r\n\r\n", "relaxed")).toBe("a\r\nb\r\n");
  });

  it("the empty-body asymmetry is preserved (simple → CRLF, relaxed → empty)", () => {
    // In the RFC and load-bearing: getting this backwards fails the body hash
    // of every empty-bodied message.
    expect(canonicalizeBody("", "simple")).toBe(CRLF);
    expect(canonicalizeBody("", "relaxed")).toBe("");
  });

  it("splitMessage handles bare-LF as well as CRLF", () => {
    expect(splitMessage("A: 1\n\nbody").body).toBe("body");
    expect(splitMessage("A: 1\r\n\r\nbody").body).toBe("body");
  });

  it("parseHeaderLines folds continuation lines into their parent header", () => {
    const h = parseHeaderLines("Subject: one\r\n  two\r\nFrom: x@y.z");
    expect(h).toHaveLength(2);
    expect(h[0].name).toBe("subject");
    expect(h[0].line).toBe("Subject: one\r\n  two");
  });

  it("parseTagList reads DKIM tag syntax including base64 padding", () => {
    const t = parseTagList("v=DKIM1; k=rsa; p=MIIBIjAN==");
    expect(t).toEqual({ v: "DKIM1", k: "rsa", p: "MIIBIjAN==" });
  });

  it("extractAddress prefers the angle-bracket form", () => {
    expect(extractAddress(" Sarah Rodriguez <RecDirector@NewGloucester.com>")).toBe(
      "recdirector@newgloucester.com"
    );
    expect(extractAddress(" bare@example.com ")).toBe("bare@example.com");
  });

  it("domainsAlign is relaxed, and rejects a lookalike suffix", () => {
    expect(domainsAlign("newgloucester.com", "newgloucester.com")).toBe(true);
    expect(domainsAlign("newgloucester.com", "mail.newgloucester.com")).toBe(true);
    // The trap: endsWith without the dot would call these aligned.
    expect(domainsAlign("gloucester.com", "newgloucester.com")).toBe(false);
    expect(domainsAlign(null, "x.com")).toBe(false);
  });
});
