import { describe, it, expect } from "vitest";
import { parseVendorSocialLinks } from "../vendor-social";

describe("parseVendorSocialLinks", () => {
  it("returns {} for null", () => {
    expect(parseVendorSocialLinks(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(parseVendorSocialLinks(undefined)).toEqual({});
  });

  it("returns {} for empty string", () => {
    expect(parseVendorSocialLinks("")).toEqual({});
  });

  it("returns {} for whitespace-only string", () => {
    expect(parseVendorSocialLinks("   ")).toEqual({});
  });

  it("parses a JSON string into an object", () => {
    const raw = JSON.stringify({
      twitter: "https://twitter.com/tworoadsbrewing",
      facebook: "https://www.facebook.com/TwoRoadsBrewing",
    });
    expect(parseVendorSocialLinks(raw)).toEqual({
      twitter: "https://twitter.com/tworoadsbrewing",
      facebook: "https://www.facebook.com/TwoRoadsBrewing",
    });
  });

  it("returns {} for malformed JSON", () => {
    expect(parseVendorSocialLinks("{not json")).toEqual({});
  });

  it("returns {} for a JSON string that is not an object", () => {
    expect(parseVendorSocialLinks(JSON.stringify(["a", "b"]))).toEqual({});
    expect(parseVendorSocialLinks(JSON.stringify("hello"))).toEqual({});
    expect(parseVendorSocialLinks(JSON.stringify(42))).toEqual({});
    expect(parseVendorSocialLinks(JSON.stringify(null))).toEqual({});
  });

  it("accepts a plain object input", () => {
    const input = { instagram: "https://instagram.com/foo" };
    expect(parseVendorSocialLinks(input)).toEqual({
      instagram: "https://instagram.com/foo",
    });
  });

  it("strips empty-string and non-string values from an object input", () => {
    const input: Record<string, unknown> = {
      twitter: "https://twitter.com/foo",
      facebook: "",
      youtube: null,
      tiktok: 42,
    };
    expect(parseVendorSocialLinks(input)).toEqual({
      twitter: "https://twitter.com/foo",
    });
  });

  it("does NOT char-spread a JSON string (regression test for sameAs bug)", () => {
    const raw = '{"twitter":"https://twitter.com/foo"}';
    const result = parseVendorSocialLinks(raw);
    const values = Object.values(result);
    // The bug produced: ["{", "\"", "t", "w", "i", "t", "t", "e", "r", ...]
    // The fix produces: ["https://twitter.com/foo"]
    expect(values).toEqual(["https://twitter.com/foo"]);
    expect(values.length).toBe(1);
    expect(values[0].length).toBeGreaterThan(1);
  });
});
