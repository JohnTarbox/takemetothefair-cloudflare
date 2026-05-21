import { describe, it, expect } from "vitest";
import { classifyDomainTier, compareTier, isHigherTier } from "./source-tier";

describe("classifyDomainTier", () => {
  describe("T1 (organizer's own site)", () => {
    it("matches against contactEmailDomain", () => {
      expect(
        classifyDomainTier("https://artisansmarketunity.com/events/", {
          contactEmailDomain: "artisansmarketunity.com",
        })
      ).toBe("T1");
    });

    it("matches against promoterHost", () => {
      expect(
        classifyDomainTier("https://www.unityfair.org/2026", {
          promoterHost: "unityfair.org",
        })
      ).toBe("T1");
    });

    it("matches when subdomain differs but eTLD+1 agrees", () => {
      expect(
        classifyDomainTier("https://shop.unityfair.org/tickets", {
          contactEmailDomain: "unityfair.org",
        })
      ).toBe("T1");
    });

    it("doesn't match a Gmail contact against an unrelated event URL", () => {
      expect(
        classifyDomainTier("https://eventbrite.com/e/abc", {
          contactEmailDomain: "gmail.com",
        })
      ).toBe("T3");
    });
  });

  describe("T2 (DMO / tourism / .gov / chamber)", () => {
    it("matches curated DMO list (visitmaine.com)", () => {
      expect(classifyDomainTier("https://visitmaine.com/events/")).toBe("T2");
    });

    it("matches curated DMO list (newportri.com)", () => {
      expect(classifyDomainTier("https://www.newportri.com/wine-festival")).toBe("T2");
    });

    it("matches .gov hosts", () => {
      expect(classifyDomainTier("https://maine.gov/parks/events")).toBe("T2");
      expect(classifyDomainTier("https://nh.gov/agriculture/fair")).toBe("T2");
    });

    it("matches visit{name}.com pattern", () => {
      expect(classifyDomainTier("https://visitsomeplace.com/events")).toBe("T2");
    });

    it("matches chamber-of-commerce hosts", () => {
      expect(classifyDomainTier("https://www.chamberofcommerce.com/town/")).toBe("T2");
    });

    it("does NOT match T2 when contactEmailDomain matches first (T1 wins)", () => {
      // A DMO emailing about its own events is T1 (organizer), not T2.
      expect(
        classifyDomainTier("https://visitmaine.com/event/abc", {
          contactEmailDomain: "visitmaine.com",
        })
      ).toBe("T1");
    });
  });

  describe("T3 (aggregator / general / fallback)", () => {
    it("classifies eventbrite as T3", () => {
      expect(classifyDomainTier("https://eventbrite.com/e/abc")).toBe("T3");
    });

    it("classifies facebook as T3", () => {
      expect(classifyDomainTier("https://www.facebook.com/events/12345")).toBe("T3");
    });

    it("classifies general content sites as T3", () => {
      expect(classifyDomainTier("https://example.com/events")).toBe("T3");
    });

    it("returns T3 for null/empty/invalid URLs", () => {
      expect(classifyDomainTier(null)).toBe("T3");
      expect(classifyDomainTier(undefined)).toBe("T3");
      expect(classifyDomainTier("")).toBe("T3");
      expect(classifyDomainTier("not a url")).toBe("T3");
    });
  });

  describe("compareTier", () => {
    it("returns negative when a is more authoritative", () => {
      expect(compareTier("T1", "T2")).toBeLessThan(0);
      expect(compareTier("T1", "T3")).toBeLessThan(0);
      expect(compareTier("T2", "T3")).toBeLessThan(0);
    });

    it("returns zero when equal", () => {
      expect(compareTier("T1", "T1")).toBe(0);
      expect(compareTier("T2", "T2")).toBe(0);
      expect(compareTier("T3", "T3")).toBe(0);
    });

    it("returns positive when b is more authoritative", () => {
      expect(compareTier("T3", "T1")).toBeGreaterThan(0);
      expect(compareTier("T2", "T1")).toBeGreaterThan(0);
    });
  });

  describe("isHigherTier", () => {
    it("true when candidate is more authoritative than existing", () => {
      expect(isHigherTier("T1", "T2")).toBe(true);
      expect(isHigherTier("T2", "T3")).toBe(true);
      expect(isHigherTier("T1", "T3")).toBe(true);
    });

    it("false when candidate is equal", () => {
      expect(isHigherTier("T2", "T2")).toBe(false);
    });

    it("false when candidate is less authoritative", () => {
      expect(isHigherTier("T3", "T2")).toBe(false);
      expect(isHigherTier("T2", "T1")).toBe(false);
    });
  });
});
