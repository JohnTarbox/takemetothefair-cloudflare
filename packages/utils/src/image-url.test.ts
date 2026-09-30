/**
 * OPE-1112 — `vendors.logo_url` accepted any string.
 *
 * The corpus below is not invented. Every URL in the two "prod" blocks was
 * read out of `vendors.logo_url` on 2026-09-22, and the split between them is
 * the whole point of the test: my first sweep used "does it end in .jpg" and
 * called 14 rows broken. Six of those were real logos carrying a cache-buster
 * (`?v=1720552338`). The true count was 8.
 *
 * So this file pins the rule from BOTH sides. Tests that only listed bad URLs
 * would pass with a validator that rejects everything — and a validator that
 * rejects everything is worse than the bug, because it would lock 106 vendors
 * out of a field that currently works for them.
 */
import { describe, it, expect } from "vitest";
import { checkImageUrl } from "./image-url";

/** The verdict-only shorthand. See the note in image-url.ts about why the
 *  production module exports no such helper. */
const ok = (u: string | null | undefined) => checkImageUrl(u).ok;

/** Read from prod 2026-09-22. Genuinely broken — a page, not an image. */
const PROD_BROKEN = [
  "https://www.facebook.com/profile.php?id=61568647635851", // Margaret's
  "https://www.instagram.com/douseskin/",
  "https://www.etsy.com/shop/PlushMoss",
  "https://linktr.ee/AnchoredHomesteadCT",
  "https://www.amazon.com/author/miss.terri_2026-moments",
  "https://share.icloud.com/photos/03f4nJUkzWu_JMYz5MlGdql5Q",
  "http://www.yourhomewiz.com",
  "http://www.readingtheworldinc.com",
  "http://www.bluemountainjamaicanrestaurant.com",
];

/** Read from prod 2026-09-22. REAL logos my crude `.jpg` sweep wrongly flagged. */
const PROD_VALID_BUT_QUERY_STRINGED = [
  "https://cdn.shopify.com/s/files/1/0703/9710/0141/files/Updated_Hangtag_Front.jpg?v=1786546389",
  "https://partyhatpaperco.com/cdn/shop/files/Black_logo_1_140x.png?v=1720552338",
  "https://www.womenspeacecollection.com/cdn/shop/t/22/assets/logo.png?v=55902742977779517281605982414",
  "https://cdn.shopify.com/s/files/1/0510/6506/1559/files/logo_2x_7d742834.png?height=200",
  "https://scontent-iad6-1.cdninstagram.com/v/t51.82787-19/806784655_17901514278577559.jpg?",
];

describe("OPE-1112 — the prod corpus, from both sides", () => {
  it.each(PROD_BROKEN)("rejects %s", (url) => {
    expect(ok(url)).toBe(false);
  });

  it.each(PROD_VALID_BUT_QUERY_STRINGED)("ACCEPTS %s", (url) => {
    // LANDMARK. A rule that fails these is the one I nearly shipped: the
    // extension test has to run on the PATH, not on the whole URL.
    expect(ok(url)).toBe(true);
  });
});

describe("OPE-1112 — the reason names what the vendor pasted", () => {
  it("says 'a Facebook page', not 'no image extension'", () => {
    // Margaret reported this as "the photo wouldn't show". An error that said
    // "no image extension" would not have told her what to do differently; the
    // one thing she needed to learn is that a page link is not a picture.
    const { ok, reason } = checkImageUrl("https://www.facebook.com/profile.php?id=61568647635851");
    expect(ok).toBe(false);
    expect(reason).toContain("a Facebook page");
    // …and it must point at the thing that now exists and actually works.
    expect(reason).toContain("Upload your logo");
  });

  it("an Instagram PROFILE is a page; the Instagram CDN is an image", () => {
    expect(ok("https://www.instagram.com/douseskin/")).toBe(false);
    expect(ok("https://scontent-iad6-1.cdninstagram.com/v/t51/806784655.jpg")).toBe(true);
  });
});

describe("OPE-1112 — clearing the field stays possible", () => {
  it.each([null, undefined, "", "   "])("treats %p as OK", (value) => {
    // "No logo" is a legitimate state, and the repair step for the 8 broken
    // rows NULLs them. A validator that rejected empty would make the fix
    // unapplyable through the very form it is meant to protect.
    expect(ok(value as string | null | undefined)).toBe(true);
  });
});

describe("OPE-1112 — shape checks", () => {
  it("rejects a non-URL string", () => {
    expect(ok("my logo.png")).toBe(false);
  });

  it("rejects a non-http scheme", () => {
    // `data:` and `javascript:` both parse as valid URLs. Neither belongs in a
    // column that is interpolated into an <img src>.
    expect(ok("javascript:alert(1)")).toBe(false);
    expect(ok("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
  });

  it("accepts a plain extension URL on an unknown host", () => {
    // The common good case: a vendor's own site serving a real file. The rule
    // must not require a known CDN, or it becomes an allow-list of brands.
    expect(ok("https://some-small-maker.example/img/logo.webp")).toBe(true);
  });

  it("accepts our own CDN, which serves extensionless keys", () => {
    expect(ok("https://cdn.meetmeatthefair.com/v/abc123")).toBe(true);
  });

  it("is case-insensitive about the extension", () => {
    expect(ok("https://example.com/LOGO.PNG")).toBe(true);
  });
});
