import { describe, it, expect } from "vitest";
import { isVendorIndexable } from "../vendor-quality";

describe("isVendorIndexable", () => {
  it("indexable when description is set", () => {
    expect(isVendorIndexable({ description: "Hand-crafted goods" })).toBe(true);
  });

  it("indexable when website is set", () => {
    expect(isVendorIndexable({ website: "https://example.com" })).toBe(true);
  });

  it("indexable when both are set", () => {
    expect(
      isVendorIndexable({
        description: "Hand-crafted goods",
        website: "https://example.com",
      })
    ).toBe(true);
  });

  it("not indexable when both are null", () => {
    expect(isVendorIndexable({ description: null, website: null })).toBe(false);
  });

  it("not indexable when both are missing", () => {
    expect(isVendorIndexable({})).toBe(false);
  });

  it("not indexable when both are empty strings", () => {
    expect(isVendorIndexable({ description: "", website: "" })).toBe(false);
  });

  it("not indexable when both are whitespace-only", () => {
    expect(isVendorIndexable({ description: "   ", website: "\t\n " })).toBe(false);
  });

  it("indexable when description is non-empty and website is missing", () => {
    expect(isVendorIndexable({ description: "x", website: null })).toBe(true);
  });
});
