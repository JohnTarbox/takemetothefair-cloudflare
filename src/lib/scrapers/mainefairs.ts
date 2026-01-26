// Scraper for mainefairs.net
// Extracts fair/event data from their calendar page

export interface ScrapedEvent {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  name: string;
  startDate: Date;
  endDate: Date;
  description?: string;
  location?: string;
  city?: string;
  state?: string;
  address?: string;
  imageUrl?: string;
  ticketUrl?: string;
}

export interface ScrapeResult {
  success: boolean;
  events: ScrapedEvent[];
  error?: string;
}

// Parse date strings like "June 11 - June 14" with year context
function parseDateRange(dateText: string, year: number): { start: Date; end: Date } | null {
  // Clean up the text
  const cleaned = dateText.trim();

  // Try to match patterns like "June 11 - June 14" or "June 11-14"
  const rangeMatch = cleaned.match(/(\w+)\s+(\d+)\s*[-–]\s*(?:(\w+)\s+)?(\d+)/i);

  if (rangeMatch) {
    const startMonth = rangeMatch[1];
    const startDay = parseInt(rangeMatch[2]);
    const endMonth = rangeMatch[3] || startMonth;
    const endDay = parseInt(rangeMatch[4]);

    const start = new Date(`${startMonth} ${startDay}, ${year}`);
    const end = new Date(`${endMonth} ${endDay}, ${year}`);

    // If end is before start, it might span years
    if (end < start) {
      end.setFullYear(year + 1);
    }

    // Set times
    start.setHours(9, 0, 0, 0);
    end.setHours(21, 0, 0, 0);

    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      return { start, end };
    }
  }

  // Try single date like "June 11"
  const singleMatch = cleaned.match(/(\w+)\s+(\d+)/i);
  if (singleMatch) {
    const month = singleMatch[1];
    const day = parseInt(singleMatch[2]);
    const date = new Date(`${month} ${day}, ${year}`);
    date.setHours(9, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(21, 0, 0, 0);

    if (!isNaN(date.getTime())) {
      return { start: date, end: endDate };
    }
  }

  return null;
}

// Extract slug from URL like "/event/springfield-fair/"
function extractSlugFromUrl(url: string): string {
  const match = url.match(/\/event\/([^/]+)/);
  return match ? match[1] : url.replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

export async function scrapeMaineFairs(): Promise<ScrapeResult> {
  const SOURCE_NAME = "mainefairs.net";
  const CALENDAR_URL = "https://mainefairs.net/fairs/fair-calendar/";

  try {
    // Fetch the calendar page
    const response = await fetch(CALENDAR_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        events: [],
        error: `Failed to fetch calendar page: ${response.status} ${response.statusText}`,
      };
    }

    const html = await response.text();
    const events: ScrapedEvent[] = [];

    // Current year for date parsing
    const currentYear = new Date().getFullYear();

    // Parse event cards from HTML
    // Looking for patterns like event links and date information
    // The site uses a card layout with event names linking to detail pages

    // Match event links with their URLs
    const eventLinkRegex = /<a[^>]*href="(https?:\/\/mainefairs\.net\/event\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    const dateRegex = /(\w+\s+\d+\s*[-–]\s*(?:\w+\s+)?\d+)/g;

    // Find all event sections - they typically have a date marker followed by event info
    // Split by date markers
    const sections = html.split(/<div[^>]*class="[^"]*tribe-events-calendar-list__event-date-tag[^"]*"[^>]*>/i);

    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];

      // Find event link in this section
      const linkMatch = section.match(/<a[^>]*href="(https:\/\/mainefairs\.net\/event\/[^"]+)"[^>]*class="[^"]*tribe-events-calendar-list__event-title-link[^"]*"[^>]*>([^<]+)<\/a>/i);

      if (!linkMatch) {
        // Try alternative pattern
        const altLinkMatch = section.match(/<a[^>]*href="(https:\/\/mainefairs\.net\/event\/[^"]+)"[^>]*>([^<]+)<\/a>/i);
        if (!altLinkMatch) continue;
      }

      const eventUrl = linkMatch ? linkMatch[1] : "";
      const eventName = linkMatch ? linkMatch[2].trim() : "";

      if (!eventName || !eventUrl) continue;

      // Find date in this section
      const dateMatch = section.match(/(\w+\s+\d+)\s*[-–]\s*(\w+\s+\d+)/i) ||
                        section.match(/(\w+\s+\d+)/i);

      let startDate = new Date();
      let endDate = new Date();

      if (dateMatch) {
        const dates = parseDateRange(dateMatch[0], currentYear);
        if (dates) {
          startDate = dates.start;
          endDate = dates.end;
        }
      }

      // Extract image URL if present
      let imageUrl: string | undefined;
      const imgMatch = section.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
      if (imgMatch) {
        imageUrl = imgMatch[1];
      }

      const sourceId = extractSlugFromUrl(eventUrl);

      events.push({
        sourceId,
        sourceName: SOURCE_NAME,
        sourceUrl: eventUrl,
        name: eventName,
        startDate,
        endDate,
        imageUrl,
        ticketUrl: eventUrl,
        state: "ME", // Maine fairs
      });
    }

    // If the above parsing didn't work well, try a simpler approach
    if (events.length === 0) {
      // Look for all event links
      const allLinks = html.matchAll(/<a[^>]*href="(https:\/\/mainefairs\.net\/event\/([^"]+))"[^>]*>([^<]*(?:Fair|Festival|Show|Exhibition)[^<]*)<\/a>/gi);

      for (const match of allLinks) {
        const eventUrl = match[1];
        const slug = match[2].replace(/\/$/, '');
        const eventName = match[3].trim();

        if (!eventName) continue;

        // Check if we already have this event
        if (events.some(e => e.sourceId === slug)) continue;

        events.push({
          sourceId: slug,
          sourceName: SOURCE_NAME,
          sourceUrl: eventUrl,
          name: eventName,
          startDate: new Date(),
          endDate: new Date(),
          ticketUrl: eventUrl,
          state: "ME",
        });
      }
    }

    return {
      success: true,
      events,
    };
  } catch (error) {
    return {
      success: false,
      events: [],
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

// Fetch additional details from an event's detail page
export async function scrapeEventDetails(eventUrl: string): Promise<Partial<ScrapedEvent>> {
  try {
    const response = await fetch(eventUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)',
      },
    });

    if (!response.ok) {
      return {};
    }

    const html = await response.text();
    const details: Partial<ScrapedEvent> = {};

    // Try to extract description
    const descMatch = html.match(/<div[^>]*class="[^"]*tribe-events-single-event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (descMatch) {
      // Strip HTML tags and clean up
      details.description = descMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
    }

    // Try to extract venue/location
    const venueMatch = html.match(/<span[^>]*class="[^"]*tribe-venue[^"]*"[^>]*>([^<]+)<\/span>/i);
    if (venueMatch) {
      details.location = venueMatch[1].trim();
    }

    // Try to extract address
    const addressMatch = html.match(/<address[^>]*class="[^"]*tribe-events-address[^"]*"[^>]*>([\s\S]*?)<\/address>/i);
    if (addressMatch) {
      const addressText = addressMatch[1].replace(/<[^>]+>/g, ', ').replace(/,\s*,/g, ',').trim();
      details.address = addressText;

      // Try to extract city
      const cityMatch = addressMatch[1].match(/<span[^>]*class="[^"]*tribe-locality[^"]*"[^>]*>([^<]+)<\/span>/i);
      if (cityMatch) {
        details.city = cityMatch[1].trim();
      }
    }

    // Try to get a better image
    const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"[^>]*>/i);
    if (ogImageMatch) {
      details.imageUrl = ogImageMatch[1];
    }

    // Extract dates more accurately from the detail page
    const dateMatch = html.match(/(\w+\s+\d+,?\s*\d*)\s*[-–@]\s*(\w+\s+\d+,?\s*\d*)/i);
    if (dateMatch) {
      const year = new Date().getFullYear();
      const startStr = dateMatch[1].includes(',') ? dateMatch[1] : `${dateMatch[1]}, ${year}`;
      const endStr = dateMatch[2].includes(',') ? dateMatch[2] : `${dateMatch[2]}, ${year}`;

      const start = new Date(startStr);
      const end = new Date(endStr);

      if (!isNaN(start.getTime())) {
        start.setHours(9, 0, 0, 0);
        details.startDate = start;
      }
      if (!isNaN(end.getTime())) {
        end.setHours(21, 0, 0, 0);
        details.endDate = end;
      }
    }

    return details;
  } catch {
    return {};
  }
}
