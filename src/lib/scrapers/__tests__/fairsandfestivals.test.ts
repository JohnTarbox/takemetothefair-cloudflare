/**
 * Tests for fairsandfestivals.net scraper.
 *
 * Why this scraper specifically: it was the source of the URL contamination
 * fixed by migration 0036 (33% of populated ticket_url values came from here),
 * it's a multi-state aggregator (highest event volume of any source), and
 * its date-parsing logic has 5 fallback patterns. Real regressions here
 * silently produce events with missing/wrong dates.
 *
 * Pattern matches src/lib/scrapers/__tests__/mainefairs.test.ts: feed HTML
 * fixtures to the parser, assert on the parsed output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  scrapeFairsAndFestivals,
  scrapeFairsAndFestivalsUrl,
  parseEventsFromHtml,
  scrapeEventDetails,
  scrapeMultipleStates,
} from "../fairsandfestivals";

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseEventsFromHtml — date parsing", () => {
  it("parses state-page format (month name in class='month' span)", () => {
    const html = `
      <div class="event">
        <h4>Springfield Fair</h4>
        <p class="date"><span class="month">February</span> 01 <span class="year">2026</span></p>
        <td class="location"><span class="city">Springfield</span> <span class="state">ME</span> Springfield Fairgrounds</td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/states/ME");

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event.name).toBe("Springfield Fair");
    expect(event.startDate).toBeInstanceOf(Date);
    expect(event.startDate?.getMonth()).toBe(1); // February
    expect(event.startDate?.getDate()).toBe(1);
    expect(event.startDate?.getFullYear()).toBe(2026);
    expect(event.datesConfirmed).toBe(true);
  });

  it("parses search-results format (hidden month number + visible name span)", () => {
    const html = `
      <div class="event">
        <h4>Winter Market</h4>
        <p class="date"><span class="month" style="display: none;">1</span><span>January</span> 31, <span class="year">2026</span></p>
        <td class="location"><span class="city">Augusta</span> <span class="state">ME</span></td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/search");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].startDate?.getMonth()).toBe(0); // January
    expect(result.events[0].startDate?.getDate()).toBe(31);
  });

  it("falls back to 'Month Day, Year' anywhere in section when structured date missing", () => {
    const html = `
      <div class="event">
        <h4>Fallback Fair</h4>
        <td>Some text mentioning June 15, 2026 in passing</td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].startDate?.getMonth()).toBe(5); // June
    expect(result.events[0].startDate?.getDate()).toBe(15);
  });

  it("falls back to Unix timestamp from data-text attribute", () => {
    // 1745020800 = 2025-04-19T00:00:00Z
    const html = `
      <div class="event">
        <h4>Timestamp Fair</h4>
        <span class="timestamp">1745020800</span>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].startDate).toBeInstanceOf(Date);
    expect(result.events[0].startDate?.getUTCFullYear()).toBe(2025);
  });

  it("emits event with no date when parsing fails entirely (datesConfirmed=false)", () => {
    const html = `
      <div class="event">
        <h4>Undated Event</h4>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].startDate).toBeUndefined();
    expect(result.events[0].datesConfirmed).toBe(false);
  });
});

describe("parseEventsFromHtml — content extraction", () => {
  it("decodes HTML entities in event name", () => {
    const html = `
      <div class="event">
        <h4>Tom &amp; Jerry&#039;s Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    expect(result.events[0].name).toBe("Tom & Jerry's Fair");
  });

  it("extracts city, state, and venue name from location cell", () => {
    const html = `
      <div class="event">
        <h4>Located Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
        <td class="location"><span class="city">Burlington</span> <span class="state">VT</span> Memorial Auditorium</td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "VT", "https://www.fairsandfestivals.net/states/VT");

    const event = result.events[0];
    expect(event.city).toBe("Burlington");
    expect(event.state).toBe("VT");
    expect(event.venue?.name).toBe("Memorial Auditorium");
    expect(event.venue?.city).toBe("Burlington");
  });

  it("normalizes full state name to 2-letter code", () => {
    const html = `
      <div class="event">
        <h4>Full State Name Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
        <td class="location"><span class="city">Springfield</span> <span class="state">Massachusetts</span></td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "MA", "https://www.fairsandfestivals.net/states/MA");

    expect(result.events[0].state).toBe("MA");
  });

  it("falls back to defaultState when no state span present", () => {
    const html = `
      <div class="event">
        <h4>No State Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
      </div>
    `;
    const result = parseEventsFromHtml(html, "NH", "https://www.fairsandfestivals.net/x");

    expect(result.events[0].state).toBe("NH");
  });

  it("strips HTML tags and decodes entities in description", () => {
    const html = `
      <div class="event">
        <h4>Described Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
        <td class="field-name">Description:</td><td>A <strong>great</strong> fair with caf&eacute; food. <a href="/x">View more detail</a></td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    const desc = result.events[0].description;
    expect(desc).toContain("great fair");
    expect(desc).not.toContain("<strong>");
    expect(desc).not.toContain("View more detail");
  });

  it("flags commercialVendorsAllowed=true when vendor types include Commercial", () => {
    const html = `
      <div class="event">
        <h4>Commercial Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
        <td class="field-name">Types of Vendor:</td><td>Art Craft Commercial Food</td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    expect(result.events[0].commercialVendorsAllowed).toBe(true);
    expect(result.events[0].vendorTypes).toContain("Commercial");
  });

  it("flags commercialVendorsAllowed=false when only Art/Craft listed", () => {
    const html = `
      <div class="event">
        <h4>Art Only Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
        <td class="field-name">Types of Vendor:</td><td>Art Craft</td>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    expect(result.events[0].commercialVendorsAllowed).toBe(false);
  });

  it("derives sourceUrl from detail link, sourceId from URL slug", () => {
    const html = `
      <div class="event">
        <h4>Linked Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
        <a href="/events/details/2026-portland-wedding-show">View more detail</a>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    const event = result.events[0];
    expect(event.sourceId).toBe("2026-portland-wedding-show");
    expect(event.sourceUrl).toBe(
      "https://www.fairsandfestivals.net/events/details/2026-portland-wedding-show"
    );
    expect(event.ticketUrl).toBe(
      "https://www.fairsandfestivals.net/events/details/2026-portland-wedding-show"
    );
  });

  it("parses multiple events on a state listing page", () => {
    const html = `
      <div class="event">
        <h4>Event One</h4>
        <p class="date"><span class="month">February</span> 01 <span class="year">2026</span></p>
      </div>
      <div class="event">
        <h4>Event Two</h4>
        <p class="date"><span class="month">March</span> 15 <span class="year">2026</span></p>
      </div>
      <div class="event">
        <h4>Event Three</h4>
        <p class="date"><span class="month">April</span> 22 <span class="year">2026</span></p>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/states/ME");

    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.name)).toEqual(["Event One", "Event Two", "Event Three"]);
  });

  it("returns empty events array for HTML with no event divs", () => {
    const result = parseEventsFromHtml(
      "<html><body>No events here</body></html>",
      "ME",
      "https://www.fairsandfestivals.net/x"
    );

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(0);
  });

  it("skips event divs that lack a name (no h4)", () => {
    const html = `
      <div class="event">
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
      </div>
      <div class="event">
        <h4>Real Event</h4>
        <p class="date"><span class="month">June</span> 16 <span class="year">2026</span></p>
      </div>
    `;
    const result = parseEventsFromHtml(html, "ME", "https://www.fairsandfestivals.net/x");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].name).toBe("Real Event");
  });
});

describe("scrapeFairsAndFestivalsUrl — fetch behavior", () => {
  it("rejects URLs not on fairsandfestivals.net", async () => {
    const result = await scrapeFairsAndFestivalsUrl("https://example.com/events");

    expect(result.success).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.error).toContain("fairsandfestivals.net");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns failure on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });

    const result = await scrapeFairsAndFestivalsUrl("https://www.fairsandfestivals.net/states/ME");

    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });

  it("returns failure on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await scrapeFairsAndFestivalsUrl("https://www.fairsandfestivals.net/states/ME");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Network timeout");
  });

  it("parses events from a successful fetch", async () => {
    const html = `
      <div class="event">
        <h4>Fetched Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
      </div>
    `;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const result = await scrapeFairsAndFestivalsUrl("https://www.fairsandfestivals.net/states/ME");

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].name).toBe("Fetched Fair");
  });
});

describe("scrapeFairsAndFestivals (state-page entry point)", () => {
  it("builds the correct state-page URL and uppercases the state code", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("<html></html>"),
    });

    await scrapeFairsAndFestivals("me");

    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = String(mockFetch.mock.calls[0][0]);
    expect(calledUrl).toBe("https://www.fairsandfestivals.net/states/ME");
  });
});

describe("scrapeEventDetails", () => {
  it("returns empty object when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await scrapeEventDetails("https://www.fairsandfestivals.net/events/details/x");

    expect(result).toEqual({});
  });

  it("returns empty object on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await scrapeEventDetails("https://www.fairsandfestivals.net/events/details/x");

    expect(result).toEqual({});
  });

  it("extracts og:image, description, date range, and venue from detail page", async () => {
    const html = `
      <html>
        <head>
          <meta property="og:image" content="https://example.com/poster.jpg">
        </head>
        <body>
          <div class="event-description">Description of Event: A wonderful fair with great vendors and family-friendly activities. Information: Some events do get cancelled or postponed.</div>
          <p>March 21-22, 2026</p>
          <strong>Event Location</strong>
          Memorial Auditorium<br>
          250 Main Street<br>
          Burlington, VT 05401
          <a href="/end">end</a>
          Website: <a href="https://burlingtonfair.org">Visit</a>
          Address: 250 Main Street, Burlington VT
        </body>
      </html>
    `;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const result = await scrapeEventDetails(
      "https://www.fairsandfestivals.net/events/details/burlington-fair"
    );

    expect(result.imageUrl).toBe("https://example.com/poster.jpg");
    expect(result.description).toContain("wonderful fair");
    expect(result.description).not.toContain("Description of Event:");
    expect(result.description).not.toContain("Some events do get cancelled");
    expect(result.startDate?.getMonth()).toBe(2); // March
    expect(result.startDate?.getDate()).toBe(21);
    expect(result.endDate?.getDate()).toBe(22);
    expect(result.website).toBe("https://burlingtonfair.org");
    expect(result.venue?.name).toBe("Memorial Auditorium");
    expect(result.venue?.city).toBe("Burlington");
    expect(result.venue?.state).toBe("VT");
    expect(result.venue?.zip).toBe("05401");
  });

  it("does not set description when too short (< 50 chars)", async () => {
    const html = `<div class="event-description">Short.</div>`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(html),
    });

    const result = await scrapeEventDetails("https://www.fairsandfestivals.net/events/details/x");

    expect(result.description).toBeUndefined();
  });
});

describe("scrapeMultipleStates", () => {
  it("aggregates events across multiple state pages", async () => {
    const meHtml = `
      <div class="event"><h4>ME Fair</h4>
        <p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p>
      </div>`;
    const nhHtml = `
      <div class="event"><h4>NH Fair</h4>
        <p class="date"><span class="month">July</span> 4 <span class="year">2026</span></p>
      </div>`;
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(meHtml) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(nhHtml) });

    const result = await scrapeMultipleStates(["ME", "NH"]);

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.name).sort()).toEqual(["ME Fair", "NH Fair"]);
  });

  it("collects per-state errors and reports them in result.error", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Down" })
      .mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            `<div class="event"><h4>Good Fair</h4><p class="date"><span class="month">June</span> 15 <span class="year">2026</span></p></div>`
          ),
      });

    const result = await scrapeMultipleStates(["ME", "NH"]);

    expect(result.success).toBe(false); // any per-state failure flips it
    expect(result.events).toHaveLength(1); // partial results still returned
    expect(result.error).toContain("ME");
    expect(result.error).toContain("503");
  });
});
