import { describe, expect, it } from "vitest";
import { deriveStateFromText } from "../venue-matching";

describe("deriveStateFromText — last-resort regex fallback", () => {
  it("returns the state code when exactly one NE state is mentioned", () => {
    expect(
      deriveStateFromText("Located at Hillsborough County 4-H Fairgrounds, New Boston, NH")
    ).toBe("NH");
    expect(deriveStateFromText("Brattleboro, Vermont — annual show")).toBe("VT");
    expect(deriveStateFromText("Maine Maple Sunday event in Skowhegan, Maine")).toBe("ME");
  });

  it("recognizes both abbreviations and full names interchangeably", () => {
    expect(deriveStateFromText("happens in MA on Saturday")).toBe("MA");
    expect(deriveStateFromText("happens in Massachusetts on Saturday")).toBe("MA");
  });

  it("returns null when multiple NE states are mentioned (ambiguous)", () => {
    // Don't pick one when prose mentions several — admin should disambiguate
    expect(deriveStateFromText("New England series: stops in NH, MA, and Maine")).toBeNull();
  });

  it("returns null when no NE state is mentioned", () => {
    expect(deriveStateFromText("happens in California next week")).toBeNull();
    expect(deriveStateFromText("just some prose with no state")).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(deriveStateFromText(null)).toBeNull();
    expect(deriveStateFromText("")).toBeNull();
    expect(deriveStateFromText(undefined)).toBeNull();
  });

  it("dedups multiple mentions of the same state (NH appearing twice → still NH)", () => {
    expect(deriveStateFromText("first event in NH; second event in New Hampshire")).toBe("NH");
  });
});
