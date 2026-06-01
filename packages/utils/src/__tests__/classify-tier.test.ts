import { describe, it, expect } from "vitest";
import { classifyDedupTier } from "../duplicates";

describe("classifyDedupTier", () => {
  it("treats exact_url as HIGH", () => {
    expect(classifyDedupTier("exact_url")).toBe("high");
  });

  it("treats venue_date as HIGH", () => {
    expect(classifyDedupTier("venue_date")).toBe("high");
  });

  it("treats city_state_date as MEDIUM", () => {
    // city + state alone is too coarse — busy Saturdays in Portland
    // genuinely have multiple distinct events. Operator triages.
    expect(classifyDedupTier("city_state_date")).toBe("medium");
  });

  it("treats similar_name_date as MEDIUM", () => {
    // The 0.85 Levenshtein threshold false-positives on near-name
    // collisions (Spring Craft Fair / Spring Crafts Fair) which are
    // genuinely different regional events.
    expect(classifyDedupTier("similar_name_date")).toBe("medium");
  });

  it("treats unknown match types as MEDIUM (safer default)", () => {
    // Defensive: an unrecognized matchType shouldn't auto-route to
    // already-exists. PENDING + possible_duplicate_of tag is safer.
    expect(classifyDedupTier("future_new_match_type")).toBe("medium");
  });
});
