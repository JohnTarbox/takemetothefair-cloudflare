// OPE-482 — fixtures use Date.UTC(..., 12) rather than the LOCAL-time
// `new Date(y, m, d)` constructor. These four assertions passed on a developer
// machine in America/New_York and failed on CI's UTC runner: local-midnight is
// 04:00Z in EDT and 00:00Z in UTC, and date-only rendering is now Eastern, so
// the UTC runner's value resolved to the previous day. The tests were always
// host-dependent; switching the render zone is what made it observable.
import { describe, it, expect } from "vitest";
import {
  createSlug,
  generateMultiDayICSContent,
  formatDate,
  formatDateRange,
  formatPrice,
  truncate,
  generateGoogleCalendarUrl,
  generateOutlookCalendarUrl,
  generateICSContent,
  getSlugPrefixBounds,
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
    const date = new Date(Date.UTC(2024, 5, 15, 12)); // June 15, 2024
    const result = formatDate(date);
    expect(result).toContain("Jun");
    expect(result).toContain("15");
    expect(result).toContain("2024");
  });

  it("formats date string correctly", () => {
    // Explicit Z: without it this is parsed as LOCAL time, so the assertion
    // depended on the host zone (it fails in Asia/Tokyo). Same class as the
    // Date.UTC fixtures above.
    const result = formatDate("2024-12-25T12:00:00Z");
    expect(result).toContain("Dec");
    expect(result).toContain("25");
    expect(result).toContain("2024");
  });

  it("includes weekday in output", () => {
    const date = new Date(Date.UTC(2024, 5, 15, 12)); // June 15, 2024 is a Saturday
    const result = formatDate(date);
    expect(result).toContain("Sat");
  });

  it("returns formatted string with expected parts", () => {
    const date = new Date(Date.UTC(2024, 0, 1, 12));
    const result = formatDate(date);
    expect(result).toMatch(/\w+,\s+\w+\s+\d+,\s+\d{4}/);
  });
});

describe("formatDateRange", () => {
  it("returns single date format when start equals end", () => {
    const start = new Date(Date.UTC(2024, 5, 15, 12));
    const end = new Date(Date.UTC(2024, 5, 15, 12));
    const result = formatDateRange(start, end);
    expect(result).not.toContain(" - ");
  });

  it("returns range format when dates differ", () => {
    const start = new Date(Date.UTC(2024, 5, 15, 12));
    const end = new Date(Date.UTC(2024, 5, 17, 12));
    const result = formatDateRange(start, end);
    expect(result).toContain(" - ");
    expect(result).toContain("15");
    expect(result).toContain("17");
  });

  it("handles string inputs with explicit times", () => {
    const result = formatDateRange("2024-06-15T12:00:00", "2024-06-17T12:00:00");
    expect(result).toContain(" - ");
  });

  it("returns TBD when start is null", () => {
    const result = formatDateRange(null, new Date(Date.UTC(2024, 5, 15, 12)));
    expect(result).toBe("TBD");
  });

  it("returns just the start date when end is null", () => {
    // Asymmetric with the start-is-null case: knowing the start is more
    // useful UX than rendering "TBD". formatDateRange falls through to
    // formatDate(startDate) when end is missing. See src/lib/utils.ts:97-99.
    const result = formatDateRange(new Date(Date.UTC(2024, 5, 15, 12)), null);
    expect(result).toBe("Sat, Jun 15, 2024");
  });

  it("returns TBD when both are null", () => {
    const result = formatDateRange(null, null);
    expect(result).toBe("TBD");
  });

  it("returns TBD for invalid date strings", () => {
    const result = formatDateRange("invalid", "also-invalid");
    expect(result).toBe("TBD");
  });
});

describe("formatPrice", () => {
  // Inputs are integer CENTS (post-0044). $10 = 1000 cents, $10.50 = 1050.
  it('returns "Price TBD" when no prices are set (distinct from explicitly $0)', () => {
    expect(formatPrice()).toBe("Price TBD");
    expect(formatPrice(null, null)).toBe("Price TBD");
    expect(formatPrice(undefined, undefined)).toBe("Price TBD");
    expect(formatPrice(null, undefined)).toBe("Price TBD");
  });

  it("returns single price when min equals max", () => {
    expect(formatPrice(1000, 1000)).toBe("$10");
  });

  it("returns single price when only min provided", () => {
    expect(formatPrice(1500)).toBe("$15");
    expect(formatPrice(1500, null)).toBe("$15");
  });

  it('returns "Up to" format when only max provided', () => {
    expect(formatPrice(null, 2500)).toBe("Up to $25");
    expect(formatPrice(undefined, 2500)).toBe("Up to $25");
  });

  it("returns range format when both min and max differ", () => {
    expect(formatPrice(1000, 2500)).toBe("$10 - $25");
  });

  it("handles zero values correctly", () => {
    expect(formatPrice(0, 1000)).toBe("Up to $10");
    expect(formatPrice(0, 0)).toBe("Free");
  });

  it("renders cents with two decimals when not whole dollars", () => {
    expect(formatPrice(1050)).toBe("$10.50");
    expect(formatPrice(99)).toBe("$0.99");
    expect(formatPrice(1050, 2575)).toBe("$10.50 - $25.75");
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

describe("getSlugPrefixBounds", () => {
  it("returns correct bounds for simple slug", () => {
    const [lower, upper] = getSlugPrefixBounds("my-event");
    expect(lower).toBe("my-event-");
    expect(upper).toBe("my-event/");
  });

  it("bounds correctly capture numbered suffixes", () => {
    const [lower, upper] = getSlugPrefixBounds("my-event");
    // "my-event-2" should be > lower and < upper
    expect("my-event-2" > lower).toBe(true);
    expect("my-event-2" < upper).toBe(true);
  });

  it("bounds correctly capture text suffixes", () => {
    const [lower, upper] = getSlugPrefixBounds("fair");
    // "fair-2026" should be in bounds
    expect("fair-2026" > lower).toBe(true);
    expect("fair-2026" < upper).toBe(true);
    // "fair-extended-edition" should be in bounds
    expect("fair-extended-edition" > lower).toBe(true);
    expect("fair-extended-edition" < upper).toBe(true);
  });

  it("bounds exclude the base slug itself", () => {
    const [lower, _upper] = getSlugPrefixBounds("my-event");
    // "my-event" should NOT be > lower (it's less than "my-event-")
    expect("my-event" > lower).toBe(false);
  });

  it("bounds exclude unrelated slugs", () => {
    const [lower, upper] = getSlugPrefixBounds("my-event");
    // "my-events" should NOT be captured (it doesn't have the hyphen after "my-event")
    expect("my-events" > lower && "my-events" < upper).toBe(false);
    // "my-event" without suffix should NOT be captured
    expect("my-event" > lower && "my-event" < upper).toBe(false);
  });
});

/**
 * OPE-640 — the multi-day ICS UID.
 *
 * Nine logged occurrences of `TypeError: crypto.randomUUID is not a function`
 * on `/events/*`, all `react-error-boundary` — i.e. the visitor got the
 * "Something went wrong" boundary INSTEAD OF THE PAGE. Captured agents were
 * Safari 14.1.2 and Chrome 90; `crypto.randomUUID` needs Safari 15.4 / Chrome 92.
 *
 * The first test reproduces THE CONDITION (the API is absent) rather than its
 * neighbourhood — it deletes `randomUUID` and asserts the render survives, so
 * it fails against the old line and cannot pass by accident. The second pins
 * the reason a polyfill would have been the wrong fix.
 */
describe("multi-day ICS UID (OPE-640)", () => {
  const params = {
    title: "Cannon Grange Agricultural Fair",
    url: "https://meetmeatthefair.com/events/cannon-grange-agricultural-fair/2026",
    eventDays: [
      { date: "2026-08-22", openTime: "09:00", closeTime: "17:00" },
      { date: "2026-08-23", openTime: "09:00", closeTime: "17:00" },
    ],
  };

  it("renders on a browser that has no crypto.randomUUID (Safari 14 / Chrome 90)", () => {
    // `delete globalThis.crypto.randomUUID` does NOT work here and this test
    // was decorative until that was caught: in Node the method lives on
    // `Crypto.prototype`, so there is no OWN property to delete and the API
    // stayed reachable — the test passed against the unfixed line. Shadowing
    // it with an own `undefined` is what actually reproduces a pre-2022
    // browser, and makes the call throw the exact production TypeError.
    const c = globalThis.crypto as unknown as Record<string, unknown>;
    const hadOwn = Object.prototype.hasOwnProperty.call(c, "randomUUID");
    const prior = Object.getOwnPropertyDescriptor(c, "randomUUID");
    Object.defineProperty(c, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(typeof globalThis.crypto.randomUUID).toBe("undefined"); // the condition really holds
      expect(() => generateMultiDayICSContent(params)).not.toThrow();
    } finally {
      if (hadOwn && prior) Object.defineProperty(c, "randomUUID", prior);
      else delete c.randomUUID;
    }
  });

  it("is stable across renders, so re-importing UPDATES instead of duplicating", () => {
    // The random UID made every download a new calendar identity: importing
    // the .ics twice added every day twice. Stability is the correctness
    // property, not just a side effect of dropping the UUID.
    expect(generateMultiDayICSContent(params)).toBe(generateMultiDayICSContent(params));
  });

  it("still gives each day its own distinct UID", () => {
    const uids = [...generateMultiDayICSContent(params).matchAll(/UID:([^\r\n]+)/g)].map(
      (m) => m[1]
    );
    expect(uids).toHaveLength(2);
    expect(new Set(uids).size).toBe(2);
  });
});
