/**
 * OPE-411 — ingest sanity checks.
 *
 * The negative cases carry the weight here. Every one of these rules sits in
 * front of a real submitter, so a rule that is too eager silently rejects real
 * events — a worse outcome than the junk it was written to catch, because the
 * junk was at least visible in PENDING.
 */
import { describe, it, expect } from "vitest";
import {
  isUnusableEventName,
  isLikelyImageUrl,
  isPlaceholderUrl,
  stripLocationTail,
} from "./submission-sanitize";

describe("isUnusableEventName", () => {
  it("rejects the name that produced this ticket", () => {
    // Submitted 2026-08-04; minted the slug /event/facebook.
    expect(isUnusableEventName("Facebook")).toBe(true);
    expect(isUnusableEventName("  facebook  ")).toBe(true);
  });

  it("rejects other platform tokens and non-answers", () => {
    for (const junk of ["Instagram", "eventbrite", "N/A", "unknown", "TBD", "website", "-"]) {
      expect(isUnusableEventName(junk), junk).toBe(true);
    }
  });

  it("rejects a URL or hostname pasted into the name field", () => {
    expect(isUnusableEventName("https://www.facebook.com/groups/914030575288176")).toBe(true);
    expect(isUnusableEventName("www.craftfair.org")).toBe(true);
    expect(isUnusableEventName("facebook.com/groups/123")).toBe(true);
  });

  it("ACCEPTS a real name that merely contains a platform word", () => {
    // The reason the rule is exact-match rather than substring. These are real
    // event names and rejecting them would be the worse failure.
    expect(isUnusableEventName("Facebook Marketplace Craft Fair")).toBe(false);
    expect(isUnusableEventName("Google Developer Fest 2026")).toBe(false);
    expect(isUnusableEventName("Instagram Pop-Up Market")).toBe(false);
  });

  it("accepts ordinary event names", () => {
    for (const name of [
      "Northeast Egg & Art Expo 2026",
      "Lovell Old Home Days",
      "4-H Fair",
      "Winthrop Arts Festival",
    ]) {
      expect(isUnusableEventName(name), name).toBe(false);
    }
  });

  it("treats an empty or missing name as unusable", () => {
    expect(isUnusableEventName("")).toBe(true);
    expect(isUnusableEventName(null)).toBe(true);
    expect(isUnusableEventName("  ")).toBe(true);
  });
});

describe("isLikelyImageUrl", () => {
  it("rejects the webpage that landed in image_url in prod", () => {
    expect(isLikelyImageUrl("https://crafters-choice-llc.square.site/")).toBe(false);
  });

  it("accepts real image URLs by extension, case-insensitively", () => {
    expect(isLikelyImageUrl("https://example.org/poster.jpg")).toBe(true);
    expect(isLikelyImageUrl("https://example.org/a/b/POSTER.PNG")).toBe(true);
    expect(isLikelyImageUrl("https://example.org/x.webp?width=800")).toBe(true);
  });

  it("accepts the extensionless image-CDN URLs that are live in prod", () => {
    // These are two of the four rows OPE-411 flagged as "non-image values in
    // image_url". They are real images; an extension-only rule would have
    // wrongly nulled them in the backfill. The data corrected the rule.
    expect(
      isLikelyImageUrl(
        "https://cdn-az.allevents.in/events1/banners/7afed27af694068a39f3bbc8909b7bdda11ed7423a968b6d8f15277be39dfb19-rimg-w934-h1169-dcbf8f31-gmir?v=1779535098"
      )
    ).toBe(true);
    expect(
      isLikelyImageUrl(
        "https://lh3.googleusercontent.com/qFibo4OVSmcs2EnhH3qBwuPspmjbx3nMsXs8Y6eYZewfd3deeuvlEyVXqkUVIM44Milqzl8Ud3IjZxY=w1200-h630-p"
      )
    ).toBe(true);
    // …and the two whose extension sits before a query string.
    expect(
      isLikelyImageUrl(
        "http://static1.squarespace.com/static/5421ee98/t/65f4778d/Caravan%2BFinal.jpg?format=1500w"
      )
    ).toBe(true);
  });

  it("still rejects a deep page URL on a non-asset host", () => {
    // The rule must not become "any URL with a path".
    expect(isLikelyImageUrl("https://www.facebook.com/groups/914030575288176")).toBe(false);
    expect(isLikelyImageUrl("https://crafters-choice-llc.square.site/shop")).toBe(false);
  });

  it("rejects an asset host with no path", () => {
    expect(isLikelyImageUrl("https://cdn.example.com/")).toBe(false);
  });

  it("accepts our own extensionless delivery hosts", () => {
    expect(isLikelyImageUrl("https://cdn.meetmeatthefair.com/vendor-assets/abc123")).toBe(true);
    expect(isLikelyImageUrl("https://meetmeatthefair.com/cdn-cgi/image/width=800/whatever")).toBe(
      true
    );
  });

  it("rejects non-URLs and non-http schemes", () => {
    expect(isLikelyImageUrl("poster.jpg")).toBe(false);
    expect(isLikelyImageUrl("javascript:alert(1)")).toBe(false);
    expect(isLikelyImageUrl(null)).toBe(false);
  });
});

describe("isPlaceholderUrl", () => {
  it("catches the placeholder live in prod today", () => {
    expect(isPlaceholderUrl("https://example.com/buy-tickets")).toBe(true);
  });

  it("catches localhost, bare hashes and non-URLs", () => {
    expect(isPlaceholderUrl("http://localhost:3000/tickets")).toBe(true);
    expect(isPlaceholderUrl("#")).toBe(true);
    expect(isPlaceholderUrl("n/a")).toBe(true);
    expect(isPlaceholderUrl("ask the organizer")).toBe(true);
  });

  it("treats empty as absent, not placeholder", () => {
    // The caller distinguishes "no value" from "junk value"; conflating them
    // would make an absent field look like a submitter error.
    expect(isPlaceholderUrl("")).toBe(false);
    expect(isPlaceholderUrl(null)).toBe(false);
  });

  it("accepts real ticket URLs", () => {
    expect(isPlaceholderUrl("https://www.eventbrite.com/e/12345")).toBe(false);
    expect(isPlaceholderUrl("https://crafters-choice-llc.square.site/")).toBe(false);
  });
});

describe("stripLocationTail", () => {
  it("removes the block the submit route appends", () => {
    const desc =
      "A spring craft fair with 40 vendors.\n\nLocation: Best Western Merry Manor Inn, 700 Main st, South Portland, ME";
    expect(stripLocationTail(desc)).toBe("A spring craft fair with 40 vendors.");
  });

  it("leaves a description with no such block untouched", () => {
    expect(stripLocationTail("Just a description.")).toBe("Just a description.");
    expect(stripLocationTail(null)).toBeNull();
  });

  it("does NOT empty a description whose whole body was the location block", () => {
    // Returning "" here would replace a partly-useful description with nothing.
    const desc = "\n\nLocation: Somewhere, ME";
    expect(stripLocationTail(desc)).toBe(desc);
  });

  it("strips only the LAST block, so prose mentioning a location survives", () => {
    const desc = "Location: see below for details.\n\nA fair.\n\nLocation: Town Common, Lovell, ME";
    expect(stripLocationTail(desc)).toBe("Location: see below for details.\n\nA fair.");
  });
});
