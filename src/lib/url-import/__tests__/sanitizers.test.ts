/**
 * Tests for URL Import sanitizer functions
 * These are pure functions extracted from ai-extractor.ts for testing
 */

import { describe, it, expect } from "vitest";

// Re-implement the sanitizer functions here for testing since they're not exported
// In production, consider exporting these from ai-extractor.ts

function sanitizeString(value: unknown, maxLength?: number): string | null {
  if (value === null || value === undefined) return null;
  let str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;
  if (maxLength && str.length > maxLength) {
    str = str.substring(0, maxLength - 3) + "...";
  }
  return str;
}

function sanitizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null" || str.toLowerCase() === "tbd") return null;

  try {
    // If it's already in ISO format, validate and return
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(str)) {
      const date = new Date(str);
      if (!isNaN(date.getTime())) {
        if (str.includes("T")) {
          return date.toISOString().substring(0, 19);
        }
        return str.substring(0, 10);
      }
    }

    // Handle MM/DD/YYYY or M/D/YYYY format
    const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slashMatch) {
      const month = slashMatch[1].padStart(2, "0");
      const day = slashMatch[2].padStart(2, "0");
      let year = slashMatch[3];
      if (year.length === 2) {
        year = parseInt(year) > 50 ? `19${year}` : `20${year}`;
      }
      return `${year}-${month}-${day}`;
    }

    // Handle "Month Day, Year" format
    const monthNames: Record<string, string> = {
      january: "01", jan: "01",
      february: "02", feb: "02",
      march: "03", mar: "03",
      april: "04", apr: "04",
      may: "05",
      june: "06", jun: "06",
      july: "07", jul: "07",
      august: "08", aug: "08",
      september: "09", sep: "09", sept: "09",
      october: "10", oct: "10",
      november: "11", nov: "11",
      december: "12", dec: "12",
    };

    const monthDayYear = str.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})$/i);
    if (monthDayYear) {
      const monthNum = monthNames[monthDayYear[1].toLowerCase()];
      if (monthNum) {
        const day = monthDayYear[2].padStart(2, "0");
        return `${monthDayYear[3]}-${monthNum}-${day}`;
      }
    }

    // Handle "Day Month Year" format
    const dayMonthYear = str.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+),?\s*(\d{4})$/i);
    if (dayMonthYear) {
      const monthNum = monthNames[dayMonthYear[2].toLowerCase()];
      if (monthNum) {
        const day = dayMonthYear[1].padStart(2, "0");
        return `${dayMonthYear[3]}-${monthNum}-${day}`;
      }
    }

    // Try native Date parsing as fallback
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      const year = date.getFullYear();
      if (year >= 2020 && year <= 2100) {
        return date.toISOString().substring(0, 10);
      }
    }
  } catch {
    // Parsing failed
  }

  return null;
}

function sanitizeState(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toUpperCase();
  if (str === "" || str.toLowerCase() === "null") return null;

  if (/^[A-Z]{2}$/.test(str)) {
    return str;
  }

  const stateMap: Record<string, string> = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    "NEW HAMPSHIRE": "NH",
    "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM",
    "NEW YORK": "NY",
    "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    "WEST VIRGINIA": "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
  };

  return stateMap[str] || str.substring(0, 2);
}

function sanitizeUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;

  try {
    const url = new URL(str);
    return url.href;
  } catch {
    return null;
  }
}

function sanitizePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return value >= 0 ? value : null;
  }

  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;

  const match = str.match(/[\d.]+/);
  if (match) {
    const num = parseFloat(match[0]);
    return !isNaN(num) && num >= 0 ? num : null;
  }

  return null;
}

describe("sanitizeString", () => {
  it("returns null for null/undefined input", () => {
    expect(sanitizeString(null)).toBeNull();
    expect(sanitizeString(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(sanitizeString("")).toBeNull();
    expect(sanitizeString("   ")).toBeNull();
  });

  it("returns null for string 'null'", () => {
    expect(sanitizeString("null")).toBeNull();
    expect(sanitizeString("NULL")).toBeNull();
    expect(sanitizeString("Null")).toBeNull();
  });

  it("trims whitespace from strings", () => {
    expect(sanitizeString("  hello  ")).toBe("hello");
    expect(sanitizeString("\n\ttest\n\t")).toBe("test");
  });

  it("converts non-strings to strings", () => {
    expect(sanitizeString(123)).toBe("123");
    expect(sanitizeString(true)).toBe("true");
  });

  it("truncates strings exceeding maxLength", () => {
    expect(sanitizeString("hello world", 8)).toBe("hello...");
    expect(sanitizeString("short", 10)).toBe("short");
  });

  it("handles maxLength edge cases", () => {
    expect(sanitizeString("abc", 6)).toBe("abc");
    expect(sanitizeString("abcdefgh", 6)).toBe("abc...");
  });
});

describe("sanitizeDate", () => {
  describe("null/empty handling", () => {
    it("returns null for null/undefined input", () => {
      expect(sanitizeDate(null)).toBeNull();
      expect(sanitizeDate(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(sanitizeDate("")).toBeNull();
      expect(sanitizeDate("   ")).toBeNull();
    });

    it("returns null for 'null' string", () => {
      expect(sanitizeDate("null")).toBeNull();
      expect(sanitizeDate("NULL")).toBeNull();
    });

    it("returns null for TBD dates", () => {
      expect(sanitizeDate("TBD")).toBeNull();
      expect(sanitizeDate("tbd")).toBeNull();
    });
  });

  describe("ISO format dates", () => {
    it("parses YYYY-MM-DD format", () => {
      expect(sanitizeDate("2025-03-15")).toBe("2025-03-15");
      expect(sanitizeDate("2026-01-01")).toBe("2026-01-01");
    });

    it("parses ISO datetime format with time", () => {
      const result = sanitizeDate("2025-03-15T10:30:00");
      // Result is converted to UTC ISO format
      expect(result).toMatch(/^2025-03-15T\d{2}:\d{2}:\d{2}$/);
    });

    it("parses ISO datetime without seconds", () => {
      const result = sanitizeDate("2025-03-15T10:30");
      // Result is converted to UTC ISO format
      expect(result).toMatch(/^2025-03-15T\d{2}:\d{2}:\d{2}$/);
    });
  });

  describe("MM/DD/YYYY format", () => {
    it("parses MM/DD/YYYY format", () => {
      expect(sanitizeDate("03/15/2025")).toBe("2025-03-15");
      expect(sanitizeDate("12/25/2025")).toBe("2025-12-25");
    });

    it("parses M/D/YYYY format (single digit month/day)", () => {
      expect(sanitizeDate("3/5/2025")).toBe("2025-03-05");
      expect(sanitizeDate("1/1/2026")).toBe("2026-01-01");
    });

    it("parses MM/DD/YY format with 2-digit year", () => {
      expect(sanitizeDate("03/15/25")).toBe("2025-03-15");
      expect(sanitizeDate("12/25/26")).toBe("2026-12-25");
    });

    it("handles 2-digit years correctly (50+ = 19xx, <50 = 20xx)", () => {
      expect(sanitizeDate("01/01/99")).toBe("1999-01-01");
      expect(sanitizeDate("01/01/51")).toBe("1951-01-01");
      expect(sanitizeDate("01/01/49")).toBe("2049-01-01");
      expect(sanitizeDate("01/01/00")).toBe("2000-01-01");
    });
  });

  describe("Month Day, Year format", () => {
    it("parses 'Month Day, Year' format", () => {
      expect(sanitizeDate("January 15, 2025")).toBe("2025-01-15");
      expect(sanitizeDate("February 01, 2026")).toBe("2026-02-01");
      expect(sanitizeDate("December 25, 2025")).toBe("2025-12-25");
    });

    it("parses abbreviated month names", () => {
      expect(sanitizeDate("Jan 15, 2025")).toBe("2025-01-15");
      expect(sanitizeDate("Feb 1, 2026")).toBe("2026-02-01");
      expect(sanitizeDate("Dec 25, 2025")).toBe("2025-12-25");
    });

    it("handles ordinal suffixes (1st, 2nd, 3rd, 4th)", () => {
      expect(sanitizeDate("March 1st, 2025")).toBe("2025-03-01");
      expect(sanitizeDate("April 2nd, 2025")).toBe("2025-04-02");
      expect(sanitizeDate("May 3rd, 2025")).toBe("2025-05-03");
      expect(sanitizeDate("June 4th, 2025")).toBe("2025-06-04");
      expect(sanitizeDate("July 21st, 2025")).toBe("2025-07-21");
    });

    it("handles all month names", () => {
      expect(sanitizeDate("January 1, 2025")).toBe("2025-01-01");
      expect(sanitizeDate("February 1, 2025")).toBe("2025-02-01");
      expect(sanitizeDate("March 1, 2025")).toBe("2025-03-01");
      expect(sanitizeDate("April 1, 2025")).toBe("2025-04-01");
      expect(sanitizeDate("May 1, 2025")).toBe("2025-05-01");
      expect(sanitizeDate("June 1, 2025")).toBe("2025-06-01");
      expect(sanitizeDate("July 1, 2025")).toBe("2025-07-01");
      expect(sanitizeDate("August 1, 2025")).toBe("2025-08-01");
      expect(sanitizeDate("September 1, 2025")).toBe("2025-09-01");
      expect(sanitizeDate("October 1, 2025")).toBe("2025-10-01");
      expect(sanitizeDate("November 1, 2025")).toBe("2025-11-01");
      expect(sanitizeDate("December 1, 2025")).toBe("2025-12-01");
    });

    it("handles 'sept' abbreviation", () => {
      expect(sanitizeDate("Sept 15, 2025")).toBe("2025-09-15");
    });

    it("handles optional comma", () => {
      expect(sanitizeDate("March 15 2025")).toBe("2025-03-15");
    });
  });

  describe("Day Month Year format", () => {
    it("parses 'Day Month Year' format", () => {
      expect(sanitizeDate("15 January 2025")).toBe("2025-01-15");
      expect(sanitizeDate("1 February 2026")).toBe("2026-02-01");
    });

    it("handles ordinal suffixes in day-first format", () => {
      expect(sanitizeDate("15th January 2025")).toBe("2025-01-15");
      expect(sanitizeDate("1st February 2026")).toBe("2026-02-01");
      expect(sanitizeDate("22nd March 2025")).toBe("2025-03-22");
    });
  });

  describe("invalid dates", () => {
    it("returns null for invalid date strings", () => {
      expect(sanitizeDate("not a date")).toBeNull();
      expect(sanitizeDate("xyz")).toBeNull();
    });

    it("returns null for years outside valid range when using native parsing", () => {
      // Note: Regex-matched dates like "Month Day, Year" don't have year validation
      // Only dates that fall through to native Date parsing are validated for year range
      expect(sanitizeDate("some random text with 2019 in it")).toBeNull();
    });

    it("parses any valid year in Month Day, Year format (no year validation)", () => {
      // The regex patterns don't validate year ranges - they just parse the format
      expect(sanitizeDate("January 1, 2019")).toBe("2019-01-01");
      expect(sanitizeDate("January 1, 2101")).toBe("2101-01-01");
    });
  });
});

describe("sanitizeState", () => {
  describe("null/empty handling", () => {
    it("returns null for null/undefined input", () => {
      expect(sanitizeState(null)).toBeNull();
      expect(sanitizeState(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(sanitizeState("")).toBeNull();
      expect(sanitizeState("   ")).toBeNull();
    });
  });

  describe("two-letter codes", () => {
    it("returns uppercase 2-letter codes as-is", () => {
      expect(sanitizeState("ME")).toBe("ME");
      expect(sanitizeState("CA")).toBe("CA");
      expect(sanitizeState("NY")).toBe("NY");
    });

    it("uppercases lowercase 2-letter codes", () => {
      expect(sanitizeState("me")).toBe("ME");
      expect(sanitizeState("ca")).toBe("CA");
      expect(sanitizeState("ny")).toBe("NY");
    });
  });

  describe("full state names", () => {
    it("converts New England state names", () => {
      expect(sanitizeState("Maine")).toBe("ME");
      expect(sanitizeState("Vermont")).toBe("VT");
      expect(sanitizeState("New Hampshire")).toBe("NH");
      expect(sanitizeState("Massachusetts")).toBe("MA");
      expect(sanitizeState("Connecticut")).toBe("CT");
      expect(sanitizeState("Rhode Island")).toBe("RI");
    });

    it("converts common state names", () => {
      expect(sanitizeState("California")).toBe("CA");
      expect(sanitizeState("New York")).toBe("NY");
      expect(sanitizeState("Texas")).toBe("TX");
      expect(sanitizeState("Florida")).toBe("FL");
    });

    it("handles case insensitivity", () => {
      expect(sanitizeState("maine")).toBe("ME");
      expect(sanitizeState("MAINE")).toBe("ME");
      expect(sanitizeState("MaInE")).toBe("ME");
    });

    it("handles all 50 states", () => {
      const states = [
        ["Alabama", "AL"], ["Alaska", "AK"], ["Arizona", "AZ"], ["Arkansas", "AR"],
        ["California", "CA"], ["Colorado", "CO"], ["Connecticut", "CT"], ["Delaware", "DE"],
        ["Florida", "FL"], ["Georgia", "GA"], ["Hawaii", "HI"], ["Idaho", "ID"],
        ["Illinois", "IL"], ["Indiana", "IN"], ["Iowa", "IA"], ["Kansas", "KS"],
        ["Kentucky", "KY"], ["Louisiana", "LA"], ["Maine", "ME"], ["Maryland", "MD"],
        ["Massachusetts", "MA"], ["Michigan", "MI"], ["Minnesota", "MN"], ["Mississippi", "MS"],
        ["Missouri", "MO"], ["Montana", "MT"], ["Nebraska", "NE"], ["Nevada", "NV"],
        ["New Hampshire", "NH"], ["New Jersey", "NJ"], ["New Mexico", "NM"], ["New York", "NY"],
        ["North Carolina", "NC"], ["North Dakota", "ND"], ["Ohio", "OH"], ["Oklahoma", "OK"],
        ["Oregon", "OR"], ["Pennsylvania", "PA"], ["Rhode Island", "RI"], ["South Carolina", "SC"],
        ["South Dakota", "SD"], ["Tennessee", "TN"], ["Texas", "TX"], ["Utah", "UT"],
        ["Vermont", "VT"], ["Virginia", "VA"], ["Washington", "WA"], ["West Virginia", "WV"],
        ["Wisconsin", "WI"], ["Wyoming", "WY"]
      ];

      for (const [name, code] of states) {
        expect(sanitizeState(name)).toBe(code);
      }
    });
  });

  describe("unknown states", () => {
    it("returns first 2 characters for unknown inputs", () => {
      expect(sanitizeState("Unknown")).toBe("UN");
      expect(sanitizeState("Testing")).toBe("TE");
    });
  });
});

describe("sanitizeUrl", () => {
  describe("null/empty handling", () => {
    it("returns null for null/undefined input", () => {
      expect(sanitizeUrl(null)).toBeNull();
      expect(sanitizeUrl(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(sanitizeUrl("")).toBeNull();
      expect(sanitizeUrl("   ")).toBeNull();
    });

    it("returns null for 'null' string", () => {
      expect(sanitizeUrl("null")).toBeNull();
      expect(sanitizeUrl("NULL")).toBeNull();
    });
  });

  describe("valid URLs", () => {
    it("parses valid http URLs", () => {
      expect(sanitizeUrl("http://example.com")).toBe("http://example.com/");
      expect(sanitizeUrl("http://example.com/path")).toBe("http://example.com/path");
    });

    it("parses valid https URLs", () => {
      expect(sanitizeUrl("https://example.com")).toBe("https://example.com/");
      expect(sanitizeUrl("https://example.com/event/123")).toBe("https://example.com/event/123");
    });

    it("preserves query parameters", () => {
      expect(sanitizeUrl("https://example.com?id=123")).toBe("https://example.com/?id=123");
      expect(sanitizeUrl("https://example.com/page?foo=bar&baz=qux")).toBe("https://example.com/page?foo=bar&baz=qux");
    });

    it("preserves fragments", () => {
      expect(sanitizeUrl("https://example.com#section")).toBe("https://example.com/#section");
    });

    it("handles URLs with ports", () => {
      expect(sanitizeUrl("https://example.com:8080/path")).toBe("https://example.com:8080/path");
    });
  });

  describe("invalid URLs", () => {
    it("returns null for relative paths", () => {
      expect(sanitizeUrl("/path/to/page")).toBeNull();
      expect(sanitizeUrl("path/to/page")).toBeNull();
    });

    it("returns null for invalid URL schemes", () => {
      expect(sanitizeUrl("not-a-url")).toBeNull();
      expect(sanitizeUrl("example.com")).toBeNull();
    });

    it("returns null for malformed URLs", () => {
      expect(sanitizeUrl("http://")).toBeNull();
      expect(sanitizeUrl("://example.com")).toBeNull();
    });
  });
});

describe("sanitizePrice", () => {
  describe("null/empty handling", () => {
    it("returns null for null/undefined input", () => {
      expect(sanitizePrice(null)).toBeNull();
      expect(sanitizePrice(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(sanitizePrice("")).toBeNull();
      expect(sanitizePrice("   ")).toBeNull();
    });

    it("returns null for 'null' string", () => {
      expect(sanitizePrice("null")).toBeNull();
      expect(sanitizePrice("NULL")).toBeNull();
    });
  });

  describe("numeric input", () => {
    it("returns positive numbers as-is", () => {
      expect(sanitizePrice(10)).toBe(10);
      expect(sanitizePrice(0)).toBe(0);
      expect(sanitizePrice(99.99)).toBe(99.99);
    });

    it("returns null for negative numbers", () => {
      expect(sanitizePrice(-10)).toBeNull();
      expect(sanitizePrice(-0.01)).toBeNull();
    });
  });

  describe("string input", () => {
    it("extracts numeric value from string", () => {
      expect(sanitizePrice("10")).toBe(10);
      expect(sanitizePrice("99.99")).toBe(99.99);
    });

    it("handles currency symbols", () => {
      expect(sanitizePrice("$10")).toBe(10);
      expect(sanitizePrice("$99.99")).toBe(99.99);
      expect(sanitizePrice("€25")).toBe(25);
    });

    it("handles currency suffix", () => {
      expect(sanitizePrice("10 USD")).toBe(10);
      expect(sanitizePrice("$99.99 USD")).toBe(99.99);
    });

    it("handles 'free' by returning null (no numeric value)", () => {
      expect(sanitizePrice("free")).toBeNull();
      expect(sanitizePrice("Free")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("extracts first numeric value from complex strings", () => {
      expect(sanitizePrice("Starting at $15")).toBe(15);
      expect(sanitizePrice("$10-$20")).toBe(10);
    });

    it("handles decimal-only values", () => {
      expect(sanitizePrice(".99")).toBe(0.99);
    });
  });
});
