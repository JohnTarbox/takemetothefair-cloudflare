import { describe, it, expect } from "vitest";
import { isHijackedDescription } from "../hijacked-domain-detection";

describe("isHijackedDescription", () => {
  // Regression suite for the 2026-05-12 BAKI false-positive incident: 8
  // legitimate Maine bakeries were flagged because `LIKE %baki%` matched
  // inside `baking` / `bakery`. The refine regex now requires a brand
  // suffix (digits or known token).

  describe("BAKI brand-suffix refinement", () => {
    it("does NOT flag 'baking dishes'", () => {
      expect(isHijackedDescription("We sell handmade baking dishes for the home cook.")).toBe(
        false
      );
    });

    it("does NOT flag 'home-based baking business'", () => {
      expect(isHijackedDescription("Lorelle runs a home-based baking business in Portland.")).toBe(
        false
      );
    });

    it("does NOT flag standalone 'bakery' or 'bakeries'", () => {
      expect(isHijackedDescription("Our bakery serves sourdough daily.")).toBe(false);
      expect(isHijackedDescription("Local bakeries supply the market.")).toBe(false);
    });

    it("does NOT flag bare 'baki' without a brand suffix", () => {
      // Implausible in real content but defensive: bare token alone is no
      // longer enough — must be branded (digits or known suffix).
      expect(isHijackedDescription("This sentence contains baki by itself.")).toBe(false);
    });

    it("flags 'BAKI77 promo code'", () => {
      expect(isHijackedDescription("Get a BAKI77 promo code for new players!")).toBe(true);
    });

    it("flags 'bakislot maxwin'", () => {
      expect(isHijackedDescription("Try bakislot maxwin today.")).toBe(true);
    });

    it("flags 'BakiGacor' (case-insensitive)", () => {
      expect(isHijackedDescription("Visit BakiGacor for daily slots.")).toBe(true);
    });
  });

  describe("other spam terms still match", () => {
    it("flags 'gacor maxwin slot' (multi-token combo)", () => {
      expect(isHijackedDescription("Check out the gacor maxwin slot machines!")).toBe(true);
    });

    it("flags 'rtp slot' (multi-word phrase)", () => {
      expect(isHijackedDescription("Highest rtp slot games of 2026")).toBe(true);
    });

    it("flags 'judi online' (Indonesian gambling)", () => {
      expect(isHijackedDescription("Daftar judi online terpercaya")).toBe(true);
    });

    it("flags 'situs slot' (gambling site)", () => {
      expect(isHijackedDescription("Daftar situs slot resmi 2026")).toBe(true);
    });

    it("does NOT flag clean text", () => {
      expect(
        isHijackedDescription(
          "Maine maple syrup producer specializing in small-batch traditional sugaring."
        )
      ).toBe(false);
    });
  });
});
