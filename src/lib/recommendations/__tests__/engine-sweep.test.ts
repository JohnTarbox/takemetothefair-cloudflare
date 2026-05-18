import { describe, expect, it } from "vitest";
import { extractTopPagePath } from "../engine";

describe("extractTopPagePath — payload parsing for the stale-path sweep", () => {
  it("extracts a valid string topPagePath from valid JSON", () => {
    expect(extractTopPagePath(JSON.stringify({ topPagePath: "/events/foo" }))).toBe("/events/foo");
  });

  it("returns null when input is null (D1 column read for a row with no payload)", () => {
    expect(extractTopPagePath(null)).toBeNull();
  });

  it("returns null for malformed JSON (would have thrown previously, blocking the sweep)", () => {
    expect(extractTopPagePath("{not-json")).toBeNull();
    expect(extractTopPagePath("")).toBeNull();
  });

  it("returns null when payload is well-formed but has no topPagePath", () => {
    expect(extractTopPagePath(JSON.stringify({ otherField: "x" }))).toBeNull();
    expect(extractTopPagePath(JSON.stringify({}))).toBeNull();
  });

  it("returns null when topPagePath exists but isn't a string (e.g., number, object)", () => {
    expect(extractTopPagePath(JSON.stringify({ topPagePath: 42 }))).toBeNull();
    expect(extractTopPagePath(JSON.stringify({ topPagePath: null }))).toBeNull();
    expect(extractTopPagePath(JSON.stringify({ topPagePath: { nested: "x" } }))).toBeNull();
  });

  it("handles the real-world payload shape from low_ctr_pages (rule + path + query)", () => {
    // Mirrors what src/lib/recommendations/rules/low-ctr-pages.ts emits — keep
    // this test in sync with the rule's payload shape so a future schema
    // change doesn't silently break the sweep.
    const payload = {
      query: "wickford art festival 2026",
      impressions: 245,
      clicks: 1,
      ctr: 0.004,
      position: 7.2,
      topPagePath: "/events/63rd-wickford-art-festival-2026",
    };
    expect(extractTopPagePath(JSON.stringify(payload))).toBe(
      "/events/63rd-wickford-art-festival-2026"
    );
  });
});
