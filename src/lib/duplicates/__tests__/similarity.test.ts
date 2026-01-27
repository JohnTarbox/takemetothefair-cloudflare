import { describe, it, expect } from "vitest";
import {
  normalizeString,
  levenshteinDistance,
  levenshteinSimilarity,
  tokenize,
  jaccardSimilarity,
  tokenJaccardSimilarity,
  combinedSimilarity,
  findDuplicatePairs,
  getVenueComparisonString,
  getEventComparisonString,
  getVendorComparisonString,
  getPromoterComparisonString,
} from "../similarity";

describe("normalizeString", () => {
  it("converts to lowercase", () => {
    expect(normalizeString("Hello World")).toBe("hello world");
  });

  it("removes special characters", () => {
    expect(normalizeString("Hello! World@#$")).toBe("hello world");
  });

  it("normalizes multiple spaces", () => {
    expect(normalizeString("Hello   World")).toBe("hello world");
  });

  it("trims whitespace", () => {
    expect(normalizeString("  Hello World  ")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(normalizeString("")).toBe("");
  });

  it("handles null", () => {
    expect(normalizeString(null)).toBe("");
  });

  it("handles undefined", () => {
    expect(normalizeString(undefined)).toBe("");
  });

  it("preserves numbers", () => {
    expect(normalizeString("Event 2024")).toBe("event 2024");
  });
});

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("returns length of b for empty a", () => {
    expect(levenshteinDistance("", "hello")).toBe(5);
  });

  it("returns length of a for empty b", () => {
    expect(levenshteinDistance("hello", "")).toBe(5);
  });

  it("counts single character insertion", () => {
    expect(levenshteinDistance("hell", "hello")).toBe(1);
  });

  it("counts single character deletion", () => {
    expect(levenshteinDistance("hello", "hell")).toBe(1);
  });

  it("counts single character substitution", () => {
    expect(levenshteinDistance("hello", "hallo")).toBe(1);
  });

  it("handles completely different strings", () => {
    expect(levenshteinDistance("abc", "xyz")).toBe(3);
  });
});

describe("levenshteinSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(levenshteinSimilarity("hello", "hello")).toBe(1);
  });

  it("returns 1 for identical strings with different case", () => {
    expect(levenshteinSimilarity("Hello", "hello")).toBe(1);
  });

  it("returns 0 for empty string compared to non-empty", () => {
    expect(levenshteinSimilarity("hello", "")).toBe(0);
    expect(levenshteinSimilarity("", "hello")).toBe(0);
  });

  it("returns 1 for two empty strings", () => {
    expect(levenshteinSimilarity("", "")).toBe(1);
  });

  it("returns high similarity for similar strings", () => {
    const similarity = levenshteinSimilarity("hello", "hallo");
    expect(similarity).toBeGreaterThan(0.7);
    expect(similarity).toBeLessThan(1);
  });

  it("returns low similarity for different strings", () => {
    const similarity = levenshteinSimilarity("abc", "xyz");
    expect(similarity).toBeLessThan(0.5);
  });

  it("handles null values", () => {
    expect(levenshteinSimilarity(null as unknown as string, "hello")).toBe(0);
    expect(levenshteinSimilarity("hello", null as unknown as string)).toBe(0);
  });
});

describe("tokenize", () => {
  it("splits string into word tokens", () => {
    const tokens = tokenize("hello world");
    expect(tokens).toEqual(new Set(["hello", "world"]));
  });

  it("handles multiple spaces", () => {
    const tokens = tokenize("hello   world");
    expect(tokens).toEqual(new Set(["hello", "world"]));
  });

  it("removes duplicates", () => {
    const tokens = tokenize("hello hello world");
    expect(tokens).toEqual(new Set(["hello", "world"]));
  });

  it("returns empty set for empty string", () => {
    const tokens = tokenize("");
    expect(tokens.size).toBe(0);
  });

  it("normalizes before tokenizing", () => {
    const tokens = tokenize("Hello World!");
    expect(tokens).toEqual(new Set(["hello", "world"]));
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const a = new Set(["hello", "world"]);
    const b = new Set(["hello", "world"]);
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it("returns 0 for completely different sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 1 for two empty sets", () => {
    const a = new Set<string>();
    const b = new Set<string>();
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it("returns 0 when one set is empty", () => {
    const a = new Set(["hello"]);
    const b = new Set<string>();
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("calculates correct similarity for overlapping sets", () => {
    const a = new Set(["hello", "world"]);
    const b = new Set(["hello", "there"]);
    // Intersection: {hello} = 1
    // Union: {hello, world, there} = 3
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3);
  });
});

describe("tokenJaccardSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(tokenJaccardSimilarity("hello world", "hello world")).toBe(1);
  });

  it("handles case differences", () => {
    expect(tokenJaccardSimilarity("Hello World", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(tokenJaccardSimilarity("abc def", "xyz uvw")).toBe(0);
  });
});

describe("combinedSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(combinedSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns value between 0 and 1", () => {
    const similarity = combinedSimilarity("hello world", "hello there");
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it("uses weighted average of levenshtein and jaccard", () => {
    const a = "test string";
    const b = "test string modified";
    const similarity = combinedSimilarity(a, b, 0.6);
    expect(similarity).toBeGreaterThan(0.5);
  });

  it("respects custom weight parameter", () => {
    const a = "abc def";
    const b = "abc xyz";
    const weightedMore = combinedSimilarity(a, b, 0.9);
    const weightedLess = combinedSimilarity(a, b, 0.1);
    expect(weightedMore).not.toBe(weightedLess);
  });
});

describe("findDuplicatePairs", () => {
  it("finds pairs above threshold", () => {
    const entities = [
      { id: "1", name: "County Fair 2024" },
      { id: "2", name: "County Fair 2024" },
      { id: "3", name: "State Fair 2024" },
    ];

    const pairs = findDuplicatePairs(entities, (e) => e.name, 0.9);

    expect(pairs.length).toBe(1);
    expect(pairs[0].entity1.id).toBe("1");
    expect(pairs[0].entity2.id).toBe("2");
    expect(pairs[0].similarity).toBe(1);
  });

  it("returns empty array when no duplicates", () => {
    const entities = [
      { id: "1", name: "County Fair" },
      { id: "2", name: "State Fair" },
      { id: "3", name: "City Festival" },
    ];

    const pairs = findDuplicatePairs(entities, (e) => e.name, 0.9);
    expect(pairs.length).toBe(0);
  });

  it("returns empty array for empty input", () => {
    const pairs = findDuplicatePairs([], (e: { id: string; name: string }) => e.name);
    expect(pairs.length).toBe(0);
  });

  it("returns empty array for single entity", () => {
    const pairs = findDuplicatePairs([{ id: "1", name: "Fair" }], (e) => e.name);
    expect(pairs.length).toBe(0);
  });

  it("sorts results by similarity descending", () => {
    const entities = [
      { id: "1", name: "County Fair 2024" },
      { id: "2", name: "County Fair 2024" },
      { id: "3", name: "County Fair 2025" },
    ];

    const pairs = findDuplicatePairs(entities, (e) => e.name, 0.7);

    expect(pairs.length).toBeGreaterThan(1);
    expect(pairs[0].similarity).toBeGreaterThanOrEqual(pairs[1].similarity);
  });
});

describe("getVenueComparisonString", () => {
  it("returns name when no location", () => {
    const venue = { name: "Fairgrounds" };
    expect(getVenueComparisonString(venue)).toBe("Fairgrounds");
  });

  it("includes city when provided", () => {
    const venue = { name: "Fairgrounds", city: "Austin" };
    expect(getVenueComparisonString(venue)).toBe("Fairgrounds Austin");
  });

  it("includes city and state when provided", () => {
    const venue = { name: "Fairgrounds", city: "Austin", state: "TX" };
    expect(getVenueComparisonString(venue)).toBe("Fairgrounds Austin TX");
  });

  it("handles null name", () => {
    const venue = { name: null, city: "Austin" };
    expect(getVenueComparisonString(venue)).toBe("Austin");
  });

  it('returns "unknown" for all null values', () => {
    const venue = { name: null, city: null, state: null };
    expect(getVenueComparisonString(venue)).toBe("unknown");
  });
});

describe("getEventComparisonString", () => {
  it("returns name when no venue or date", () => {
    const event = { name: "County Fair" };
    expect(getEventComparisonString(event)).toBe("County Fair");
  });

  it("includes venue name when provided", () => {
    const event = { name: "County Fair", venue: { name: "Fairgrounds" } };
    expect(getEventComparisonString(event)).toBe("County Fair Fairgrounds");
  });

  it("includes year when date provided", () => {
    const event = { name: "County Fair", startDate: new Date("2024-06-15") };
    expect(getEventComparisonString(event)).toBe("County Fair 2024");
  });

  it("handles string date", () => {
    const event = { name: "County Fair", startDate: "2024-06-15" };
    expect(getEventComparisonString(event)).toBe("County Fair 2024");
  });

  it("includes all components", () => {
    const event = {
      name: "County Fair",
      venue: { name: "Fairgrounds" },
      startDate: new Date("2024-06-15"),
    };
    expect(getEventComparisonString(event)).toBe("County Fair Fairgrounds 2024");
  });

  it("handles null venue", () => {
    const event = { name: "County Fair", venue: null };
    expect(getEventComparisonString(event)).toBe("County Fair");
  });

  it("handles null name", () => {
    const event = { name: null };
    expect(getEventComparisonString(event)).toBe("unknown");
  });
});

describe("getVendorComparisonString", () => {
  it("returns business name when no type", () => {
    const vendor = { businessName: "Food Co" };
    expect(getVendorComparisonString(vendor)).toBe("Food Co");
  });

  it("includes vendor type when provided", () => {
    const vendor = { businessName: "Food Co", vendorType: "FOOD" };
    expect(getVendorComparisonString(vendor)).toBe("Food Co FOOD");
  });

  it("handles null vendor type", () => {
    const vendor = { businessName: "Food Co", vendorType: null };
    expect(getVendorComparisonString(vendor)).toBe("Food Co");
  });

  it("handles null business name", () => {
    const vendor = { businessName: null };
    expect(getVendorComparisonString(vendor)).toBe("unknown");
  });
});

describe("getPromoterComparisonString", () => {
  it("returns company name", () => {
    const promoter = { companyName: "Events Inc" };
    expect(getPromoterComparisonString(promoter)).toBe("Events Inc");
  });

  it("returns unknown for null company name", () => {
    const promoter = { companyName: null };
    expect(getPromoterComparisonString(promoter)).toBe("unknown");
  });
});
