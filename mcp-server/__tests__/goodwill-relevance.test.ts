/**
 * Unit tests for the K12 relevance classifier.
 *
 * The test sample IS the hand-labeled corpus per the dev-email spec:
 * each row is a name the classifier should clearly admit or reject,
 * sourced from the Lupine Festival / Rangeley audit observations on
 * 2026-06-02 plus representative names from the wider Maine corpus.
 *
 * When future tuning adjusts the rule sets in
 * mcp-server/src/goodwill/relevance.ts, these tests must continue
 * passing — they're the regression guard against accidentally
 * widening false positives (the more costly failure mode) or
 * shrinking known-good patterns.
 */

import { describe, it, expect } from "vitest";
import { isVendorRelevantEvent, classifyRelevance } from "../src/goodwill/relevance.js";

describe("K12 relevance classifier — positive admits", () => {
  const POSITIVE_NAMES = [
    // Festivals
    "Lupine Festival 2026",
    "Maine Lobster Festival",
    "Vermont Maple Festival",
    "Fall Festival at Rangeley",
    // Markets
    "Brattleboro Farmers Market 2026",
    "Holiday Market at the Civic Center",
    "Flea Market by the Bay",
    "Holiday Craft Market",
    // Shows
    "Maine Home Show",
    "New England Trade Show",
    "Antique Show at the Fairgrounds",
    "Spring Craft Show 2026",
    // Fairs
    "Fryeburg Agricultural Fair",
    "Cumberland County Fair",
    "Maine State Fair",
    // Expo
    "Maine PHCC Expo",
    "Garden & Home Expo",
    // Mixed
    "Augusta Vendor Fair",
    "Winter Holiday Fair",
  ];

  for (const name of POSITIVE_NAMES) {
    it(`admits: "${name}"`, () => {
      expect(isVendorRelevantEvent(name, null)).toBe(true);
    });
  }
});

describe("K12 relevance classifier — negative rejects", () => {
  const NEGATIVE_NAMES = [
    // Observed in the Rangeley /events page audit:
    "Author Lecture: Maine in the Civil War",
    "Watercolor Workshop with Sarah Smith",
    "Birding Class at Cupsuptic Lake",
    "Annual Meeting of the Historic Society",
    "Garden Club Federation of Maine Convention",
    "Maine Association of Retirees Annual Meeting",
    "Spring Gala Fundraiser",
    "Charity Benefit Auction",
    "Museum Admission Day",
    // Generic non-vendor events:
    "Sunday Worship Service",
    "Wednesday Bible Study",
    "Book Club: November",
    "Book Signing with Local Author",
    "Open Mic Night",
    "Town Hall Meeting",
    "Webinar: Sustainable Tourism",
    "Seminar on Estate Planning",
    "Yoga Class at Sunrise",
    // Edge: negative wins even if a positive keyword appears too
    "Festival Planning Meeting",
    "Holiday Market Workshop Series",
  ];

  for (const name of NEGATIVE_NAMES) {
    it(`rejects: "${name}"`, () => {
      expect(isVendorRelevantEvent(name, null)).toBe(false);
    });
  }
});

describe("K12 relevance classifier — empty / unclear default to false", () => {
  it("returns false for empty name", () => {
    expect(isVendorRelevantEvent("", null)).toBe(false);
  });

  it("returns false for whitespace name", () => {
    expect(isVendorRelevantEvent("   ", null)).toBe(false);
  });

  it("returns false for unrelated event names with no positive signal", () => {
    // Conservative default per the docstring — keep it out of harvest
    // queue unless explicitly admitted by a positive pattern.
    expect(isVendorRelevantEvent("Live Concert with Local Band", null)).toBe(false);
    expect(isVendorRelevantEvent("Movie Night at the Park", null)).toBe(false);
  });
});

describe("K12 relevance classifier — category supplements name", () => {
  it("name alone admits, category null", () => {
    expect(isVendorRelevantEvent("Spring Fair 2026", null)).toBe(true);
  });

  it("non-matching name + matching category admits", () => {
    expect(isVendorRelevantEvent("Annual Event", "Craft Fair")).toBe(true);
  });

  it("non-matching name + non-matching category rejects", () => {
    expect(isVendorRelevantEvent("Live Concert", "Music")).toBe(false);
  });
});

describe("K12 relevance classifier — rule attribution", () => {
  it("reports which positive rule matched", () => {
    const result = classifyRelevance("Brattleboro Farmers Market 2026", null);
    expect(result.relevant).toBe(true);
    expect(result.matchedRule).toMatch(/^pos:/);
    expect(result.matchedRule).toContain("farmers");
  });

  it("reports which negative rule matched", () => {
    const result = classifyRelevance("Spring Gala Fundraiser", null);
    expect(result.relevant).toBe(false);
    expect(result.matchedRule).toMatch(/^neg:/);
    // Either "gala" or "fundraiser" can match first — both are in the list.
    expect(result.matchedRule).toMatch(/gala|fundraiser/);
  });

  it("reports null match for default-false", () => {
    const result = classifyRelevance("Live Concert with Local Band", null);
    expect(result.relevant).toBe(false);
    expect(result.matchedRule).toBe(null);
  });

  it("reports null match for empty input", () => {
    expect(classifyRelevance("", null)).toEqual({ relevant: false, matchedRule: null });
  });
});
