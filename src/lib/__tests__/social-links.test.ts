/**
 * OPE-171 — SOCIAL_LINKS is the single source of truth for MMATF's own social
 * accounts (drives the footer + Organization JSON-LD sameAs). These lock in the
 * fix: Facebook is present, and NO Instagram link can silently return (the
 * @meetmeatthefair IG handle belongs to a third party).
 */
import { describe, it, expect } from "vitest";
import { SOCIAL_LINKS } from "../social-links";

describe("SOCIAL_LINKS (OPE-171)", () => {
  it("includes the MMATF Facebook page", () => {
    expect(SOCIAL_LINKS.some((s) => s.href === "https://facebook.com/meetmeatthefair")).toBe(true);
  });

  it("includes NO Instagram link (the @meetmeatthefair handle is not ours)", () => {
    expect(SOCIAL_LINKS.some((s) => /instagram\.com/i.test(s.href))).toBe(false);
  });

  it("every entry is well-formed (platform, label, https href, icon path)", () => {
    for (const s of SOCIAL_LINKS) {
      expect(s.platform).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.href).toMatch(/^https:\/\//);
      expect(s.iconPath).toBeTruthy();
    }
  });
});
