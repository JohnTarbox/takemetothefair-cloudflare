import { describe, expect, it } from "vitest";
import { cdnImage, OG_EVENT, OG_SQUARE, CARD_THUMB, AVATAR_SM, HERO_DESKTOP } from "../cdn-image";

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

  it("passes through foreign hosts unchanged (Google OAuth avatar)", () => {
    expect(cdnImage(foreign, AVATAR_SM)).toBe(foreign);
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

  it("omits unset optional params (height / fit / gravity / format / quality)", () => {
    const out = cdnImage(local, { width: 400 });
    expect(out).toBe(`https://meetmeatthefair.com/cdn-cgi/image/width=400/${local}`);
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
