/**
 * OPE-294 — 97.7% of venue images are hotlinked Google Places photos.
 *
 * The measured problem is that the population grows silently: venue hotlinks
 * went 172 → 173 and event hotlinks 28 → 51 between the ticket being filed
 * (2026-07-28) and re-measurement (2026-08-18), the newest arriving that same
 * day.
 */
import { describe, expect, it } from "vitest";
import { classifyImageHost, isHotlinked, OWNED_IMAGE_HOSTS } from "./image-host";

describe("the population this ticket is about", () => {
  it("flags a Google Places photo as third-party AND names it", () => {
    const v = classifyImageHost("https://lh3.googleusercontent.com/places/abc=s1600");
    expect(v.kind).toBe("third_party");
    expect(v.isGooglePlaces).toBe(true);
    expect(v.host).toBe("lh3.googleusercontent.com");
  });

  it("covers the sibling lh4/5/6 hosts Google also serves from", () => {
    // Google rotates across these. Matching only lh3 would let the same
    // photos back in under a different subdomain and read as a fix.
    for (const h of ["lh4", "lh5", "lh6"]) {
      expect(classifyImageHost(`https://${h}.googleusercontent.com/p/x`).isGooglePlaces).toBe(true);
    }
  });

  it("treats other third-party hosts as hotlinked but not Places", () => {
    // The events long tail — organizer sites. Same durability and pipeline
    // problems, no licensing question, so the two must stay distinguishable.
    const v = classifyImageHost("https://static.wixstatic.com/media/x.jpg");
    expect(v.kind).toBe("third_party");
    expect(v.isGooglePlaces).toBe(false);
  });
});

describe("what counts as ours", () => {
  it("accepts the CDN and the apex", () => {
    for (const h of OWNED_IMAGE_HOSTS) {
      expect(classifyImageHost(`https://${h}/events/a/hero.webp`).kind).toBe("owned");
    }
  });

  it("accepts a same-origin path", () => {
    expect(classifyImageHost("/images/placeholder.png").kind).toBe("owned");
  });

  it("is not fooled by a lookalike host", () => {
    // `cdn.meetmeatthefair.com.evil.test` must not read as ours.
    expect(classifyImageHost("https://cdn.meetmeatthefair.com.evil.test/x.jpg").kind).toBe(
      "third_party"
    );
  });
});

describe("absent is not borrowed", () => {
  it("classifies empty and unparseable as invalid, not third_party", () => {
    // "we have no image" and "we are borrowing one" are different facts, and a
    // caller will treat them differently — counting a null as a hotlink would
    // inflate the very number this ticket tracks.
    for (const v of [null, undefined, "", "   ", "not a url"]) {
      expect(classifyImageHost(v).kind).toBe("invalid");
    }
  });

  it("isHotlinked is false for absent values", () => {
    expect(isHotlinked(null)).toBe(false);
    expect(isHotlinked("")).toBe(false);
    expect(isHotlinked("https://cdn.meetmeatthefair.com/a.webp")).toBe(false);
    expect(isHotlinked("https://lh3.googleusercontent.com/a")).toBe(true);
  });
});
