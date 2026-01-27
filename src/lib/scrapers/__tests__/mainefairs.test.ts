/**
 * Tests for MaineFairs.net scraper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scrapeMaineFairs, scrapeEventDetails, decodeHtmlEntities } from "../mainefairs";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("decodeHtmlEntities", () => {
  it("returns empty string for empty input", () => {
    expect(decodeHtmlEntities("")).toBe("");
  });

  it("returns undefined-ish input unchanged", () => {
    expect(decodeHtmlEntities(null as unknown as string)).toBe(null);
    expect(decodeHtmlEntities(undefined as unknown as string)).toBe(undefined);
  });

  it("decodes common HTML entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("&quot;Hello&quot;")).toBe('"Hello"');
    expect(decodeHtmlEntities("It&#039;s great")).toBe("It's great");
    expect(decodeHtmlEntities("It&apos;s great")).toBe("It's great");
    expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeHtmlEntities("word&nbsp;word")).toBe("word word");
  });

  it("decodes numeric entities (decimal)", () => {
    expect(decodeHtmlEntities("&#65;&#66;&#67;")).toBe("ABC");
    expect(decodeHtmlEntities("&#8212;")).toBe("—"); // em dash
  });

  it("decodes numeric entities (hex)", () => {
    expect(decodeHtmlEntities("&#x41;&#x42;&#x43;")).toBe("ABC");
    expect(decodeHtmlEntities("&#x2014;")).toBe("—"); // em dash
  });

  it("handles mixed entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry&#039;s &quot;Show&quot;"))
      .toBe("Tom & Jerry's \"Show\"");
  });

  it("leaves non-entity text unchanged", () => {
    expect(decodeHtmlEntities("Hello World")).toBe("Hello World");
    expect(decodeHtmlEntities("No entities here")).toBe("No entities here");
  });
});

describe("scrapeMaineFairs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await scrapeMaineFairs();

    expect(result.success).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.error).toBe("Network error");
  });

  it("returns error on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const result = await scrapeMaineFairs();

    expect(result.success).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.error).toContain("404");
    expect(result.error).toContain("Not Found");
  });

  it("parses events from calendar page HTML", async () => {
    const mockHtml = `
      <div class="tribe-events-calendar-list__event-date-tag">
      </div>
      <div>
        <a href="https://mainefairs.net/event/springfield-fair/" class="tribe-events-calendar-list__event-title-link">
          Springfield Fair
        </a>
        <span>June 11 - June 14</span>
      </div>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeMaineFairs();

    expect(result.success).toBe(true);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    if (result.events.length > 0) {
      const event = result.events[0];
      expect(event.name).toBe("Springfield Fair");
      expect(event.sourceUrl).toContain("mainefairs.net");
      expect(event.sourceName).toBe("mainefairs.net");
      expect(event.state).toBe("ME");
    }
  });

  it("extracts image URLs when present", async () => {
    const mockHtml = `
      <div class="tribe-events-calendar-list__event-date-tag">
      </div>
      <div>
        <img src="https://mainefairs.net/images/fair-poster.jpg" alt="Fair">
        <a href="https://mainefairs.net/event/test-fair/" class="tribe-events-calendar-list__event-title-link">
          Test Fair
        </a>
      </div>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeMaineFairs();

    expect(result.success).toBe(true);
    if (result.events.length > 0) {
      expect(result.events[0].imageUrl).toBe("https://mainefairs.net/images/fair-poster.jpg");
    }
  });

  it("uses fallback parsing when primary parsing fails", async () => {
    const mockHtml = `
      <html>
        <body>
          <a href="https://mainefairs.net/event/county-fair/">County Fair Festival</a>
          <a href="https://mainefairs.net/event/harvest-show/">Harvest Show Exhibition</a>
        </body>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeMaineFairs();

    expect(result.success).toBe(true);
    expect(result.events.length).toBe(2);
    expect(result.events.map(e => e.name)).toContain("County Fair Festival");
    expect(result.events.map(e => e.name)).toContain("Harvest Show Exhibition");
  });

  it("handles HTML entities in event names", async () => {
    const mockHtml = `
      <div class="tribe-events-calendar-list__event-date-tag">
      </div>
      <div>
        <a href="https://mainefairs.net/event/tom-and-jerry/" class="tribe-events-calendar-list__event-title-link">
          Tom &amp; Jerry&#039;s Fair
        </a>
      </div>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeMaineFairs();

    expect(result.success).toBe(true);
    if (result.events.length > 0) {
      expect(result.events[0].name).toBe("Tom & Jerry's Fair");
    }
  });

  it("deduplicates events by sourceId", async () => {
    const mockHtml = `
      <html>
        <body>
          <a href="https://mainefairs.net/event/county-fair/">County Fair Festival</a>
          <a href="https://mainefairs.net/event/county-fair/">County Fair Festival Again</a>
        </body>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeMaineFairs();

    expect(result.success).toBe(true);
    expect(result.events.filter(e => e.sourceId === "county-fair").length).toBe(1);
  });
});

describe("scrapeEventDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty object when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result).toEqual({});
  });

  it("returns empty object on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result).toEqual({});
  });

  it("extracts data from JSON-LD structured data", async () => {
    const mockHtml = `
      <html>
        <script type="application/ld+json">
          {
            "@type": "Event",
            "name": "County Fair",
            "startDate": "2025-06-15T09:00:00",
            "endDate": "2025-06-17T21:00:00",
            "description": "Annual county fair with rides and food",
            "image": "https://example.com/fair.jpg",
            "location": {
              "name": "Fairgrounds",
              "address": {
                "streetAddress": "123 Main St",
                "addressLocality": "Portland",
                "addressRegion": "ME",
                "postalCode": "04101"
              }
            }
          }
        </script>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/county-fair/");

    expect(result.startDate).toBeInstanceOf(Date);
    expect(result.endDate).toBeInstanceOf(Date);
    expect(result.description).toBe("Annual county fair with rides and food");
    expect(result.imageUrl).toBe("https://example.com/fair.jpg");
    expect(result.location).toBe("Fairgrounds");
    expect(result.city).toBe("Portland");
    expect(result.state).toBe("ME");
    expect(result.venue).toBeDefined();
    expect(result.venue?.name).toBe("Fairgrounds");
    expect(result.venue?.streetAddress).toBe("123 Main St");
    expect(result.venue?.zip).toBe("04101");
  });

  it("handles JSON-LD array format", async () => {
    const mockHtml = `
      <html>
        <script type="application/ld+json">
          [
            { "@type": "Organization", "name": "Org" },
            { "@type": "Event", "name": "Fair", "startDate": "2025-07-01" }
          ]
        </script>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/fair/");

    expect(result.startDate).toBeInstanceOf(Date);
  });

  it("extracts description from HTML fallback", async () => {
    const mockHtml = `
      <html>
        <div class="tribe-events-single-event-description">
          <p>This is a <strong>great</strong> fair with lots of activities.</p>
        </div>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result.description).toContain("great fair");
    expect(result.description).not.toContain("<strong>");
  });

  it("extracts venue from HTML fallback", async () => {
    const mockHtml = `
      <html>
        <span class="tribe-venue">County Fairgrounds</span>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result.location).toBe("County Fairgrounds");
  });

  it("extracts og:image as fallback", async () => {
    const mockHtml = `
      <html>
        <head>
          <meta property="og:image" content="https://example.com/og-image.jpg">
        </head>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result.imageUrl).toBe("https://example.com/og-image.jpg");
  });

  it("extracts website URL from tribe-events pattern", async () => {
    const mockHtml = `
      <html>
        <span class="tribe-events-event-url tribe-events-meta-value">
          <a href="https://countyfair.org">Visit Website</a>
        </span>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result.website).toBe("https://countyfair.org");
  });

  it("skips mainefairs.net URLs as website", async () => {
    const mockHtml = `
      <html>
        <script type="application/ld+json">
          {
            "@type": "Event",
            "name": "Fair",
            "url": "https://mainefairs.net/event/fair/"
          }
        </script>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/fair/");

    expect(result.website).toBeUndefined();
  });

  it("extracts dates from HTML fallback", async () => {
    const currentYear = new Date().getFullYear();
    const mockHtml = `
      <html>
        <div>June 15 - June 17</div>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result.startDate).toBeInstanceOf(Date);
    expect(result.endDate).toBeInstanceOf(Date);
  });

  it("truncates long descriptions", async () => {
    const longDescription = "A".repeat(3000);
    const mockHtml = `
      <html>
        <script type="application/ld+json">
          {
            "@type": "Event",
            "description": "${longDescription}"
          }
        </script>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    expect(result.description?.length).toBeLessThanOrEqual(2000);
  });

  it("handles malformed JSON-LD gracefully", async () => {
    const mockHtml = `
      <html>
        <script type="application/ld+json">
          { invalid json here }
        </script>
        <meta property="og:image" content="https://example.com/fallback.jpg">
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await scrapeEventDetails("https://mainefairs.net/event/test/");

    // Should still extract other data despite JSON-LD parse failure
    expect(result.imageUrl).toBe("https://example.com/fallback.jpg");
  });
});
