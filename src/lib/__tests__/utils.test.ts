import { describe, it, expect } from "vitest";
import {
  createSlug,
  formatDate,
  formatDateRange,
  formatPrice,
  truncate,
  generateGoogleCalendarUrl,
  generateOutlookCalendarUrl,
  generateICSContent,
} from "../utils";

describe("createSlug", () => {
  it("converts text to lowercase slug", () => {
    expect(createSlug("Hello World")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(createSlug("Test! Event @ Fair")).toBe("test-event-fair");
  });

  it("trims whitespace", () => {
    expect(createSlug("  Hello World  ")).toBe("hello-world");
  });

  it("handles multiple spaces", () => {
    expect(createSlug("Hello    World")).toBe("hello-world");
  });

  it("handles empty string", () => {
    expect(createSlug("")).toBe("");
  });

  it("handles accented characters", () => {
    expect(createSlug("Café René")).toBe("cafe-rene");
  });
});

describe("formatDate", () => {
  it("formats Date object correctly", () => {
    const date = new Date(2024, 5, 15); // June 15, 2024
    const result = formatDate(date);
    expect(result).toContain("Jun");
    expect(result).toContain("15");
    expect(result).toContain("2024");
  });

  it("formats date string correctly", () => {
    const result = formatDate("2024-12-25T12:00:00");
    expect(result).toContain("Dec");
    expect(result).toContain("25");
    expect(result).toContain("2024");
  });

  it("includes weekday in output", () => {
    const date = new Date(2024, 5, 15); // June 15, 2024 is a Saturday
    const result = formatDate(date);
    expect(result).toContain("Sat");
  });

  it("returns formatted string with expected parts", () => {
    const date = new Date(2024, 0, 1);
    const result = formatDate(date);
    expect(result).toMatch(/\w+,\s+\w+\s+\d+,\s+\d{4}/);
  });
});

describe("formatDateRange", () => {
  it("returns single date format when start equals end", () => {
    const start = new Date(2024, 5, 15);
    const end = new Date(2024, 5, 15);
    const result = formatDateRange(start, end);
    expect(result).not.toContain(" - ");
  });

  it("returns range format when dates differ", () => {
    const start = new Date(2024, 5, 15);
    const end = new Date(2024, 5, 17);
    const result = formatDateRange(start, end);
    expect(result).toContain(" - ");
    expect(result).toContain("15");
    expect(result).toContain("17");
  });

  it("handles string inputs with explicit times", () => {
    const result = formatDateRange("2024-06-15T12:00:00", "2024-06-17T12:00:00");
    expect(result).toContain(" - ");
  });

  it('returns TBD when start is null', () => {
    const result = formatDateRange(null, new Date(2024, 5, 15));
    expect(result).toBe("TBD");
  });

  it('returns TBD when end is null', () => {
    const result = formatDateRange(new Date(2024, 5, 15), null);
    expect(result).toBe("TBD");
  });

  it('returns TBD when both are null', () => {
    const result = formatDateRange(null, null);
    expect(result).toBe("TBD");
  });

  it('returns TBD for invalid date strings', () => {
    const result = formatDateRange("invalid", "also-invalid");
    expect(result).toBe("TBD");
  });
});

describe("formatPrice", () => {
  it('returns "Free" when no prices provided', () => {
    expect(formatPrice()).toBe("Free");
    expect(formatPrice(null, null)).toBe("Free");
    expect(formatPrice(undefined, undefined)).toBe("Free");
  });

  it("returns single price when min equals max", () => {
    expect(formatPrice(10, 10)).toBe("$10");
  });

  it("returns single price when only min provided", () => {
    expect(formatPrice(15)).toBe("$15");
    expect(formatPrice(15, null)).toBe("$15");
  });

  it('returns "Up to" format when only max provided', () => {
    expect(formatPrice(null, 25)).toBe("Up to $25");
    expect(formatPrice(undefined, 25)).toBe("Up to $25");
  });

  it("returns range format when both min and max differ", () => {
    expect(formatPrice(10, 25)).toBe("$10 - $25");
  });

  it("handles zero values correctly", () => {
    expect(formatPrice(0, 10)).toBe("Up to $10");
    expect(formatPrice(0, 0)).toBe("Free");
  });
});

describe("truncate", () => {
  it("returns original text when shorter than length", () => {
    expect(truncate("Hello", 10)).toBe("Hello");
  });

  it("returns original text when equal to length", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });

  it("truncates and adds ellipsis when text is longer", () => {
    expect(truncate("Hello World", 5)).toBe("Hello...");
  });

  it("trims whitespace before adding ellipsis", () => {
    expect(truncate("Hello World", 6)).toBe("Hello...");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("generateGoogleCalendarUrl", () => {
  it("generates valid Google Calendar URL", () => {
    const url = generateGoogleCalendarUrl({
      title: "Test Event",
      startDate: new Date(2024, 5, 15, 10, 0),
      endDate: new Date(2024, 5, 15, 18, 0),
    });

    expect(url).toContain("google.com/calendar/render");
    expect(url).toContain("action=TEMPLATE");
    expect(url).toContain("text=Test+Event");
  });

  it("includes location when provided", () => {
    const url = generateGoogleCalendarUrl({
      title: "Test Event",
      location: "Fairgrounds",
      startDate: new Date(2024, 5, 15),
      endDate: new Date(2024, 5, 15),
    });

    expect(url).toContain("location=Fairgrounds");
  });

  it("includes description when provided", () => {
    const url = generateGoogleCalendarUrl({
      title: "Test Event",
      description: "A fun fair event",
      startDate: new Date(2024, 5, 15),
      endDate: new Date(2024, 5, 15),
    });

    expect(url).toContain("details=");
  });
});

describe("generateOutlookCalendarUrl", () => {
  it("generates valid Outlook Calendar URL", () => {
    const url = generateOutlookCalendarUrl({
      title: "Test Event",
      startDate: new Date(2024, 5, 15, 10, 0),
      endDate: new Date(2024, 5, 15, 18, 0),
    });

    expect(url).toContain("outlook.live.com/calendar");
    expect(url).toContain("subject=Test+Event");
  });
});

describe("generateICSContent", () => {
  it("generates valid ICS format", () => {
    const ics = generateICSContent({
      title: "Test Event",
      startDate: new Date(2024, 5, 15, 10, 0),
      endDate: new Date(2024, 5, 15, 18, 0),
    });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("SUMMARY:Test Event");
  });

  it("includes location in ICS", () => {
    const ics = generateICSContent({
      title: "Test Event",
      location: "Fairgrounds",
      startDate: new Date(2024, 5, 15),
      endDate: new Date(2024, 5, 15),
    });

    expect(ics).toContain("LOCATION:Fairgrounds");
  });

  it("includes URL in ICS", () => {
    const ics = generateICSContent({
      title: "Test Event",
      url: "https://example.com/event",
      startDate: new Date(2024, 5, 15),
      endDate: new Date(2024, 5, 15),
    });

    expect(ics).toContain("URL:https://example.com/event");
  });
});
