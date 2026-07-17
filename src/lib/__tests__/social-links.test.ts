/**
 * OPE-171 / OPE-235 — SOCIAL_LINKS is the single source of truth for MMATF's own
 * social accounts (drives the site footer, the Organization JSON-LD sameAs, and
 * the newsletter email footer).
 *
 * OPE-171 removed Instagram entirely because the dotless `@meetmeatthefair` IG
 * handle belongs to a third party. OPE-235 added the real, owned account —
 * `@meet.me.at.the.fair` (WITH dots). These lock in both halves: the owned
 * handle is present, and the un-owned one can never silently return.
 */
import { describe, it, expect } from "vitest";
import { SOCIAL_LINKS } from "../social-links";

/** The account MMATF actually owns (confirmed by John, 2026-07-16). */
const OWNED_INSTAGRAM = "https://instagram.com/meet.me.at.the.fair";

describe("SOCIAL_LINKS (OPE-171 / OPE-235)", () => {
  it("includes the MMATF Facebook page", () => {
    expect(SOCIAL_LINKS.some((s) => s.href === "https://facebook.com/meetmeatthefair")).toBe(true);
  });

  it("includes the OWNED Instagram account (@meet.me.at.the.fair)", () => {
    expect(SOCIAL_LINKS.some((s) => s.href === OWNED_INSTAGRAM)).toBe(true);
  });

  it("never links the un-owned dotless @meetmeatthefair Instagram handle", () => {
    // Scoped to instagram.com on purpose: Facebook's OWN handle is legitimately
    // dotless (facebook.com/meetmeatthefair), so an unscoped "no dotless handle
    // anywhere" assertion would fail on a correct entry.
    const wrongHandle = /instagram\.com\/meetmeatthefair(?![.\w])/i;
    expect(SOCIAL_LINKS.some((s) => wrongHandle.test(s.href))).toBe(false);
  });

  it("every entry is well-formed (platform, label, name, https href, icon path)", () => {
    for (const s of SOCIAL_LINKS) {
      expect(s.platform).toBeTruthy();
      expect(s.label).toBeTruthy();
      // `name` drives the newsletter email footer, which renders text rather
      // than the SVG icon (Gmail strips inline <svg>).
      expect(s.name).toBeTruthy();
      expect(s.href).toMatch(/^https:\/\//);
      expect(s.iconPath).toBeTruthy();
    }
  });

  it("has no duplicate platforms (the footer keys React nodes by platform)", () => {
    const platforms = SOCIAL_LINKS.map((s) => s.platform);
    expect(new Set(platforms).size).toBe(platforms.length);
  });
});
