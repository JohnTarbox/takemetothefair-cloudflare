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

  it("treats series_url as MEDIUM, not HIGH (OPE-454)", () => {
    // `series_url` means "same source page, different edition" — a series
    // promoter listing every show on one /shows URL. HIGH would send an
    // already-exists reply for a genuinely new edition and create nothing,
    // which is exactly what the email pipeline must not do: there is no
    // operator on that path to pass force_create.
    //
    // It reached MEDIUM by accident via the unknown-string default. Pinned
    // here so a future reshuffle of the branch order can't quietly make it
    // HIGH.
    expect(classifyDedupTier("series_url")).toBe("medium");
  });

  it("treats unknown match types as MEDIUM (safer default)", () => {
    // Defensive: an unrecognized matchType shouldn't auto-route to
    // already-exists. PENDING + possible_duplicate_of tag is safer.
    expect(classifyDedupTier("future_new_match_type")).toBe("medium");
  });
});
