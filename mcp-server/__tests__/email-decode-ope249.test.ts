/**
 * OPE-249 rework — the mailto/email decode path, closing the 7th defect class.
 *
 * Named on 2026-07-18, still staging dirty values a month later. The fixtures
 * below are the REAL prod candidate values, not invented ones, per the review's
 * "add #7442's raw value as a unit-test fixture" — it is a known-answer
 * specimen that was sitting in the queue.
 */
import { describe, it, expect } from "vitest";
import {
  decodeCfEmailProtection,
  extractVendorContact,
  isMalformedEmail,
  normalizeExtractedEmail,
} from "../src/enrichment/extract.js";

/** Candidate 7442, In The Woods Brewing, staged clean at 0.8 with flags []. */
const CAND_7442 = "info&#64;in&#116;&#104;ewoo&#100;sbrew&#105;&#110;g.c&#111;m";

describe("normalizeExtractedEmail — the real prod specimens (OPE-249)", () => {
  it.each([
    [CAND_7442, "info@inthewoodsbrewing.com", "cand 7442 — numeric entities"],
    [
      "c&#115;&#101;&#114;vice&#64;&#97;l&#108;&#97;&#110;&#115;&#111;&#110;&#46;&#99;&#111;m",
      "cservice@allanson.com",
      "cand 7895 — numeric entities (note: cservice@, not service@ — the leading c is literal)",
    ],
    ["%20office@conderoofing.com", "office@conderoofing.com", "cand 7977 — percent-encoded space"],
    ["​hello@moatmountain.com", "hello@moatmountain.com", "cand 7530 — zero-width space"],
    ["&#x69;&#x6e;&#x66;&#x6f;&#x40;&#x78;&#x2e;&#x63;&#x6f;&#x6d;", "info@x.com", "hex entities"],
  ])("decodes %s", (raw, expected) => {
    expect(normalizeExtractedEmail(raw)).toBe(expected);
  });

  it("a decoded specimen is NOT malformed — it must survive the gate, not be dropped", () => {
    // The zero-width case regressed this way once: U+200B is not whitespace to
    // `trim`, so a perfectly good address was rejected as malformed and the
    // recoverable value thrown away.
    for (const raw of [CAND_7442, "%20office@conderoofing.com", "​hello@moatmountain.com"]) {
      expect(isMalformedEmail(raw)).toBe(false);
    }
  });

  it("still rejects a value that decodes to something with no @ at all", () => {
    expect(isMalformedEmail("&#110;&#111;&#116;&#97;&#110;&#101;&#109;&#97;&#105;&#108;")).toBe(
      true
    );
  });
});

describe("Cloudflare email-protection (OPE-249)", () => {
  it("decodes the XOR scheme", () => {
    // First hex byte is the key; each following byte is plaintext XOR key.
    const plain = "info@example.com";
    const key = 0x5a;
    const hex =
      key.toString(16).padStart(2, "0") +
      [...plain].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
    expect(decodeCfEmailProtection(`/cdn-cgi/l/email-protection#${hex}`)).toBe(plain);
  });

  it("returns null for anything that is not this scheme, so callers fall through", () => {
    expect(decodeCfEmailProtection("info@example.com")).toBeNull();
    expect(decodeCfEmailProtection("/cdn-cgi/l/email-protection#zz")).toBeNull();
  });

  it("returns null when the decode does not yield an address", () => {
    // Guards against confidently emitting XOR garbage as a contact email.
    expect(decodeCfEmailProtection("email-protection#5a1122334455")).toBeNull();
  });

  it("EXTRACTS a Cloudflare-protected address from a page with no mailto at all", () => {
    // The whole point: before this the scraper saw only hex and got nothing,
    // on exactly the sites that cared enough to turn the protection on.
    const plain = "hello@protectedsite.com";
    const key = 0x2b;
    const hex =
      key.toString(16).padStart(2, "0") +
      [...plain].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
    const html = `<a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__">[email&#160;protected]</span></a>`;
    const out = extractVendorContact(html, "https://protectedsite.com/");
    expect(out.email?.value).toBe(plain);
  });
});

describe("the storage path stores what the validator saw (OPE-249/504)", () => {
  it("a mailto with numeric entities stores the DECODED address", () => {
    const html = `<a href="mailto:${CAND_7442}">Email</a>`;
    const out = extractVendorContact(html, "https://inthewoodsbrewing.com/");
    expect(out.email?.value).toBe("info@inthewoodsbrewing.com");
  });

  it("a zero-width-prefixed mailto is recovered rather than dropped", () => {
    const html = `<a href="mailto:​hello@moatmountain.com">Email</a>`;
    const out = extractVendorContact(html, "https://moatmountain.com/");
    expect(out.email?.value).toBe("hello@moatmountain.com");
  });
});
