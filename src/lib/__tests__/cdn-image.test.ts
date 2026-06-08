import { describe, expect, it } from "vitest";
import {
  cdnImage,
  focalPointGravity,
  OG_EVENT,
  OG_SQUARE,
  CARD_THUMB,
  AVATAR_SM,
  HERO_DESKTOP,
} from "../cdn-image";

// These tests pin the URL-shape contract that `cdn-cgi/image` consumers
// rely on. If a Cloudflare API change ever required a different param
// order or comma vs slash separators, every og:image + Next/Image render
// would break silently; these catch the regression at build time.

describe("cdnImage — URL composition", () => {
  const local = "https://cdn.meetmeatthefair.com/events/abc/hero.webp";
  const sameZone = "https://meetmeatthefair.com/og-default.png";
  const foreign = "https://lh3.googleusercontent.com/a/avatar.jpg";

  it("wraps same-zone URLs with cdn-cgi/image and the requested params", () => {
    const out = cdnImage(local, OG_EVENT);
    expect(out).toBe(
      "https://meetmeatthefair.com/cdn-cgi/image/width=1200,height=630,fit=cover,gravity=auto,format=auto/" +
        local
    );
  });

  it("wraps the apex-zone og-default the same way (no /og-default special case)", () => {
    const out = cdnImage(sameZone, OG_EVENT);
    expect(out.startsWith("https://meetmeatthefair.com/cdn-cgi/image/")).toBe(true);
    expect(out.endsWith(sameZone)).toBe(true);
  });

  it("applies =wN size hint to Google user-content URLs (no existing suffix)", () => {
    // Updated 2026-06-08 (foreign-backdrop fix) — was: passes through
    // unchanged. cdnImage now adds Google's `=wN` size hint on
    // lh{3..6}.googleusercontent.com URLs so the blurred-fill backdrop
    // (200w) and other foreign-hosted small renders don't pay full-res.
    expect(cdnImage(foreign, AVATAR_SM)).toBe(`${foreign}=w80`);
  });

  it("replaces existing size suffix on Google user-content URLs", () => {
    const orig = "https://lh3.googleusercontent.com/place-photos/AL8-SNxxxxxxx=s4800-w800";
    expect(cdnImage(orig, { width: 200, format: "auto" })).toBe(
      "https://lh3.googleusercontent.com/place-photos/AL8-SNxxxxxxx=w200"
    );
  });

  it("handles =s400-c (square crop) Google syntax", () => {
    const orig = "https://lh3.googleusercontent.com/a/avatar=s400-c";
    expect(cdnImage(orig, { width: 200, format: "auto" })).toBe(
      "https://lh3.googleusercontent.com/a/avatar=w200"
    );
  });

  it("handles lh4/lh5/lh6 user-content hosts too", () => {
    for (const host of ["lh3", "lh4", "lh5", "lh6"]) {
      const orig = `https://${host}.googleusercontent.com/a/avatar`;
      expect(cdnImage(orig, { width: 100, format: "auto" })).toBe(`${orig}=w100`);
    }
  });

  it("non-Google foreign hosts still pass through unchanged", () => {
    // Facebook, Twitter, arbitrary scraped event images — we don't know
    // their resize conventions, so we don't touch the URL. The blurred-
    // fill render checks `backdropSrc !== heroSrc` to skip the backdrop
    // layer in this case (bg-muted shows through).
    const fb = "https://scontent.fbcdn.net/v/t39.30808-6/abc.jpg";
    const tw = "https://pbs.twimg.com/media/xyz.jpg";
    const random = "https://example.com/somewhere/img.jpg";
    expect(cdnImage(fb, { width: 200, format: "auto" })).toBe(fb);
    expect(cdnImage(tw, { width: 200, format: "auto" })).toBe(tw);
    expect(cdnImage(random, { width: 200, format: "auto" })).toBe(random);
  });

  it("returns empty string for null/undefined/empty input", () => {
    expect(cdnImage(null, OG_EVENT)).toBe("");
    expect(cdnImage(undefined, OG_EVENT)).toBe("");
    expect(cdnImage("", OG_EVENT)).toBe("");
  });

  it("does not double-wrap an already-cdn-cgi URL", () => {
    const alreadyWrapped = "https://meetmeatthefair.com/cdn-cgi/image/width=600/" + local;
    expect(cdnImage(alreadyWrapped, OG_EVENT)).toBe(alreadyWrapped);
  });

  it("orders params: width, height, fit, gravity, format, quality", () => {
    const out = cdnImage(local, {
      width: 800,
      height: 450,
      fit: "cover",
      gravity: "face",
      format: "webp",
      quality: 75,
    });
    expect(out).toContain(
      "/cdn-cgi/image/width=800,height=450,fit=cover,gravity=face,format=webp,quality=75/"
    );
  });

  it("omits unset optional params (height / fit / gravity / format / quality / onerror)", () => {
    const out = cdnImage(local, { width: 400 });
    expect(out).toBe(`https://meetmeatthefair.com/cdn-cgi/image/width=400/${local}`);
  });

  it("appends onerror=redirect last when set (resilience fallback)", () => {
    // Verified against prod 2026-06-07: a transform whose source 404s
    // returns 404 without this param and 307→source with it. Pin the
    // exact param ordering so a future CF doc change can't quietly
    // shuffle it and weaken the contract.
    const out = cdnImage(local, {
      width: 800,
      format: "auto",
      quality: 80,
      onerror: "redirect",
    });
    expect(out).toBe(
      `https://meetmeatthefair.com/cdn-cgi/image/width=800,format=auto,quality=80,onerror=redirect/${local}`
    );
  });

  it("omits onerror when not set (callers can opt out)", () => {
    const out = cdnImage(local, { width: 800, format: "auto" });
    expect(out).not.toContain("onerror=");
    expect(out).toBe(`https://meetmeatthefair.com/cdn-cgi/image/width=800,format=auto/${local}`);
  });
});

describe("preset constants", () => {
  it("OG_EVENT is 1200×630 landscape with gravity=auto", () => {
    expect(OG_EVENT.width).toBe(1200);
    expect(OG_EVENT.height).toBe(630);
    expect(OG_EVENT.gravity).toBe("auto");
    expect(OG_EVENT.fit).toBe("cover");
  });

  it("OG_SQUARE is 1200×1200 with gravity=auto", () => {
    expect(OG_SQUARE.width).toBe(1200);
    expect(OG_SQUARE.height).toBe(1200);
    expect(OG_SQUARE.gravity).toBe("auto");
  });

  it("HERO_DESKTOP is 16:9 matching the EventDetail spec §1b ratio", () => {
    expect(HERO_DESKTOP.width / HERO_DESKTOP.height!).toBeCloseTo(16 / 9, 2);
  });

  it("CARD_THUMB is 3:2", () => {
    expect(CARD_THUMB.width / CARD_THUMB.height!).toBeCloseTo(3 / 2, 2);
  });

  it("AVATAR_SM uses gravity=face for OAuth headshots", () => {
    expect(AVATAR_SM.gravity).toBe("face");
  });
});

describe("focalPointGravity — IMG1 §1b Phase 1", () => {
  it("returns undefined for the (0.5, 0.5) center default", () => {
    // Critical for cache-key stability: omitting `gravity` from the URL
    // entirely means events at default focal point share the cache key
    // with pre-IMG1 derivative URLs (no re-billing on rollout).
    expect(focalPointGravity(0.5, 0.5)).toBeUndefined();
  });

  it("returns undefined for null/undefined inputs (treat as default)", () => {
    expect(focalPointGravity(null, null)).toBeUndefined();
    expect(focalPointGravity(undefined, undefined)).toBeUndefined();
    expect(focalPointGravity(null, 0.5)).toBeUndefined();
    expect(focalPointGravity(0.5, null)).toBeUndefined();
  });

  it("formats non-default coords as Cloudflare's XxY syntax", () => {
    expect(focalPointGravity(0.3, 0.7)).toBe("0.3x0.7");
    expect(focalPointGravity(0, 0)).toBe("0x0");
    expect(focalPointGravity(1, 1)).toBe("1x1");
  });

  it("clamps out-of-range inputs to [0, 1]", () => {
    expect(focalPointGravity(-0.5, 0.5)).toBe("0x0.5");
    expect(focalPointGravity(0.5, 1.5)).toBe("0.5x1");
    expect(focalPointGravity(-2, 2)).toBe("0x1");
  });

  it("treats non-finite inputs as default (0.5), not clamp-to-1", () => {
    // Deliberate: NaN/Infinity could plausibly clamp to a sentinel value
    // (0 for NaN, 1 for Infinity) but those would produce surprising
    // crops if a buggy form binding ever fed Infinity. Treating all
    // non-finite as "use default" matches the null/undefined path and
    // keeps invalid input from silently producing valid-looking URLs.
    expect(focalPointGravity(NaN, 0.3)).toBe("0.5x0.3");
    expect(focalPointGravity(0.3, Infinity)).toBe("0.3x0.5");
    expect(focalPointGravity(NaN, NaN)).toBeUndefined(); // both default → center → undefined
  });

  it("rounds to 3 decimal places to keep cache keys deterministic", () => {
    // Float drift: 0.1 + 0.2 = 0.30000000000000004 in JS. Round to 0.3
    // so two events with identical operator-intent focal points share
    // the same CDN cache entry.
    expect(focalPointGravity(0.1 + 0.2, 0.5)).toBe("0.3x0.5");
    expect(focalPointGravity(1 / 3, 2 / 3)).toBe("0.333x0.667");
  });

  it("composes correctly into a cdnImage call", () => {
    const src = "https://cdn.meetmeatthefair.com/events/abc/hero.jpg";
    const gravity = focalPointGravity(0.25, 0.75);
    const url = cdnImage(src, {
      width: 800,
      height: 450,
      fit: "cover",
      gravity, // type asserts: CdnImageCustomGravity | undefined ✓
      format: "auto",
    });
    expect(url).toContain("gravity=0.25x0.75");
    expect(url).toContain("fit=cover");
    expect(url).toContain("width=800");
  });
});
