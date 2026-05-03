import { describe, it, expect } from "vitest";
import {
  decodeHtmlEntities,
  createSlug,
  createSlugFromName,
  dollarsToCents,
  formatPrice,
} from "./index";

describe("decodeHtmlEntities", () => {
  it("decodes ampersands", () => {
    expect(decodeHtmlEntities("Earth Expo &amp; Convention")).toBe("Earth Expo & Convention");
  });

  it("decodes quotes and apostrophes", () => {
    expect(decodeHtmlEntities("&quot;Hello&quot; he said")).toBe('"Hello" he said');
    expect(decodeHtmlEntities("don&#039;t")).toBe("don't");
    expect(decodeHtmlEntities("don&apos;t")).toBe("don't");
  });

  it("decodes angle brackets", () => {
    expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>");
  });

  it("decodes non-breaking spaces", () => {
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });

  it("decodes numeric entities (decimal)", () => {
    expect(decodeHtmlEntities("&#65;&#66;&#67;")).toBe("ABC");
  });

  it("decodes numeric entities (hex)", () => {
    expect(decodeHtmlEntities("&#x41;&#x42;")).toBe("AB");
  });

  it("returns empty string unchanged", () => {
    expect(decodeHtmlEntities("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(decodeHtmlEntities("plain text no entities")).toBe("plain text no entities");
  });
});

describe("createSlug (canonical, slugify-backed)", () => {
  it("converts text to lowercase slug", () => {
    expect(createSlug("Hello World")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(createSlug("Test! Event @ Fair")).toBe("test-event-fair");
  });

  it("trims whitespace", () => {
    expect(createSlug("  Hello World  ")).toBe("hello-world");
  });

  it("folds accented chars to ASCII", () => {
    expect(createSlug("Café Olé")).toBe("cafe-ole");
  });

  it("handles ampersands by transliterating to 'and' (slugify default)", () => {
    expect(createSlug("R&D Department")).toBe("randd-department");
  });
});

describe("createSlugFromName (legacy, scraper-stable)", () => {
  it("converts text to lowercase slug", () => {
    expect(createSlugFromName("Hello World")).toBe("hello-world");
  });

  it("collapses non-alphanumeric runs to a single hyphen", () => {
    expect(createSlugFromName("Test!! Event @@ Fair")).toBe("test-event-fair");
  });

  it("trims hyphens at the boundaries", () => {
    expect(createSlugFromName("---Hello World---")).toBe("hello-world");
  });

  it("preserves accented chars unchanged (legacy behavior)", () => {
    // Distinct from createSlug — accented chars stay in the slug as
    // non-alphanum characters, which collapse to "-". This is the exact
    // legacy behavior; changing it would break scraper sourceId stability.
    expect(createSlugFromName("Café Olé")).toBe("caf-ol");
  });
});

describe("dollarsToCents", () => {
  it("converts whole dollars", () => {
    expect(dollarsToCents(25)).toBe(2500);
  });
  it("rounds half-cents (banker's-rounding-free, just Math.round)", () => {
    expect(dollarsToCents(10.505)).toBe(1051);
  });
  it("returns null for null/undefined", () => {
    expect(dollarsToCents(null)).toBeNull();
    expect(dollarsToCents(undefined)).toBeNull();
  });
  it("coerces numeric strings (MCP/JSON callers)", () => {
    expect(dollarsToCents("42")).toBe(4200);
    expect(dollarsToCents("3.50")).toBe(350);
  });
  it("returns null for non-numeric strings + NaN/Infinity", () => {
    expect(dollarsToCents("not a price")).toBeNull();
    expect(dollarsToCents(NaN)).toBeNull();
    expect(dollarsToCents(Infinity)).toBeNull();
    expect(dollarsToCents(-Infinity)).toBeNull();
  });
});

describe("formatPrice", () => {
  it("renders 'Free' when both bounds are null/zero", () => {
    expect(formatPrice(null, null)).toBe("Free");
    expect(formatPrice(0, 0)).toBe("Free");
    expect(formatPrice(undefined, undefined)).toBe("Free");
  });
  it("drops .00 for whole-dollar amounts", () => {
    expect(formatPrice(2500, 2500)).toBe("$25");
  });
  it("renders cents when present", () => {
    expect(formatPrice(1050, 1050)).toBe("$10.50");
  });
  it("renders 'Up to $X' when only max is set", () => {
    expect(formatPrice(0, 1000)).toBe("Up to $10");
    expect(formatPrice(null, 1000)).toBe("Up to $10");
  });
  it("renders 'min - max' for ranges", () => {
    expect(formatPrice(500, 1500)).toBe("$5 - $15");
  });
  it("collapses identical bounds to a single value", () => {
    expect(formatPrice(1000, 1000)).toBe("$10");
  });
});
