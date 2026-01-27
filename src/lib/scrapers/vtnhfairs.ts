// Scraper for vtnhfairs.org
// Extracts fair/event data from the Vermont/NH Fairs Association pages

import type { ScrapedEvent, ScrapeResult, ScrapedVenue } from "./mainefairs";

// Parse date strings like "April 25-27th", "June 6 - 8", "July 29 - August 2"
// Returns null for dates, with datesConfirmed=false for TBD/unknown dates
function parseDateRange(dateText: string, year: number): { start: Date | null; end: Date | null; datesConfirmed: boolean } {
  // Clean up the text - remove "th", "nd", "st", "rd" suffixes and trim
  const cleaned = dateText.trim()
    .replace(/(\d+)(st|nd|rd|th)/gi, '$1')
    .replace(/&nbsp;/g, ' ')
    .trim();

  // Check for "To be determined", TBD, or "No fair" - return with datesConfirmed=false
  if (cleaned.toLowerCase().includes('to be determined') ||
      cleaned.toLowerCase().includes('tbd') ||
      cleaned.toLowerCase().includes('no fair') ||
      cleaned === '') {
    return { start: null, end: null, datesConfirmed: false };
  }

  // Try to match patterns like "July 29 - August 2" (cross-month)
  const crossMonthMatch = cleaned.match(/(\w+)\s+(\d+)\s*[-–]\s*(\w+)\s+(\d+)/i);
  if (crossMonthMatch) {
    const startMonth = crossMonthMatch[1];
    const startDay = parseInt(crossMonthMatch[2]);
    const endMonth = crossMonthMatch[3];
    const endDay = parseInt(crossMonthMatch[4]);

    const start = new Date(`${startMonth} ${startDay}, ${year}`);
    const end = new Date(`${endMonth} ${endDay}, ${year}`);

    start.setHours(9, 0, 0, 0);
    end.setHours(21, 0, 0, 0);

    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      return { start, end, datesConfirmed: true };
    }
  }

  // Try to match patterns like "June 6 - 8" or "April 25-27" (same month)
  const sameMonthMatch = cleaned.match(/(\w+)\s+(\d+)\s*[-–]\s*(\d+)/i);
  if (sameMonthMatch) {
    const month = sameMonthMatch[1];
    const startDay = parseInt(sameMonthMatch[2]);
    const endDay = parseInt(sameMonthMatch[3]);

    const start = new Date(`${month} ${startDay}, ${year}`);
    const end = new Date(`${month} ${endDay}, ${year}`);

    start.setHours(9, 0, 0, 0);
    end.setHours(21, 0, 0, 0);

    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      return { start, end, datesConfirmed: true };
    }
  }

  // Try single date like "June 11" or "July 19"
  const singleMatch = cleaned.match(/(\w+)\s+(\d+)/i);
  if (singleMatch) {
    const month = singleMatch[1];
    const day = parseInt(singleMatch[2]);
    const date = new Date(`${month} ${day}, ${year}`);
    date.setHours(9, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(21, 0, 0, 0);

    if (!isNaN(date.getTime())) {
      return { start: date, end: endDate, datesConfirmed: true };
    }
  }

  // Could not parse dates - return as unconfirmed
  return { start: null, end: null, datesConfirmed: false };
}

// Create a slug from fair name
function createSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Decode HTML entities
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

interface PageConfig {
  url: string;
  sourceName: string;
  state: string;
}

interface PositionedItem {
  index: number;
  text: string;
}

interface PositionedUrl {
  index: number;
  url: string;
}

// Generic scraper for vtnhfairs.org pages
async function scrapeVtNhFairsPage(config: PageConfig): Promise<ScrapeResult> {
  try {
    // Fetch the page
    const response = await fetch(config.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        events: [],
        error: `Failed to fetch page: ${response.status} ${response.statusText}`,
      };
    }

    const html = await response.text();
    const events: ScrapedEvent[] = [];

    // Extract year from page header like "2025 Fairs"
    const yearMatch = html.match(/<span[^>]*>(\d{4})\s+Fairs?<\/span>/i);
    const pageYear = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();

    // Extract all fair names with positions (spans with font-size:20px)
    const fairNamePattern = /<span[^>]*style="[^"]*font-size:\s*20px[^"]*"[^>]*class="[^"]*wixui-rich-text__text[^"]*"[^>]*>([^<]+)<\/span>/gi;

    // Extract date/contact info with positions
    const color15Pattern = /<span[^>]*class="[^"]*color_15[^"]*wixui-rich-text__text[^"]*"[^>]*>([^<]+)<\/span>/gi;
    const fontSize16Pattern = /<span[^>]*style="[^"]*font-size:\s*16px[^"]*"[^>]*class="[^"]*wixui-rich-text__text[^"]*"[^>]*>([^<]+)<\/span>/gi;
    const letterSpacingPattern = /<span[^>]*style="[^"]*letter-spacing:\s*0em[^"]*"[^>]*class="[^"]*wixui-rich-text__text[^"]*"[^>]*>([^<]+)<\/span>/gi;

    // Extract all website URLs with positions
    const websitePattern = /<a[^>]*href="([^"]+)"[^>]*>[^<]*(?:<[^>]*>)*\s*Visit Website/gi;

    // Collect fair names with positions
    const fairNames: PositionedItem[] = [];
    let match;
    while ((match = fairNamePattern.exec(html)) !== null) {
      const name = decodeHtmlEntities(match[1].trim());
      // Skip header like "2025 Fairs"
      if (!name.match(/^\d{4}\s+(Fairs?|Events?)/i) && name.length > 0) {
        fairNames.push({ index: match.index, text: name });
      }
    }

    // Collect info spans with positions
    const allInfoItems: PositionedItem[] = [];

    color15Pattern.lastIndex = 0;
    while ((match = color15Pattern.exec(html)) !== null) {
      const text = decodeHtmlEntities(match[1].trim());
      if (text.length > 0 && text !== '​' && text !== 'Visit Website') {
        allInfoItems.push({ index: match.index, text });
      }
    }

    fontSize16Pattern.lastIndex = 0;
    while ((match = fontSize16Pattern.exec(html)) !== null) {
      const text = decodeHtmlEntities(match[1].trim());
      if (text.length > 0 && text !== '​' && text !== 'Visit Website') {
        allInfoItems.push({ index: match.index, text });
      }
    }

    letterSpacingPattern.lastIndex = 0;
    while ((match = letterSpacingPattern.exec(html)) !== null) {
      const text = decodeHtmlEntities(match[1].trim());
      if (text.length > 0 && text !== '​' && text !== 'Visit Website') {
        allInfoItems.push({ index: match.index, text });
      }
    }

    // Sort info items by position
    allInfoItems.sort((a, b) => a.index - b.index);

    // Collect website URLs with positions
    const websiteUrls: PositionedUrl[] = [];
    websitePattern.lastIndex = 0;
    while ((match = websitePattern.exec(html)) !== null) {
      websiteUrls.push({ index: match.index, url: match[1] });
    }

    // Process each fair
    for (let i = 0; i < fairNames.length; i++) {
      const fair = fairNames[i];
      const nextFairIndex = i < fairNames.length - 1 ? fairNames[i + 1].index : Infinity;

      // Find info items between this fair and the next
      const fairInfoItems = allInfoItems.filter(
        item => item.index > fair.index && item.index < nextFairIndex
      );

      // Find website URL between this fair and the next
      const fairWebsite = websiteUrls.find(
        url => url.index > fair.index && url.index < nextFairIndex
      );

      // Extract date and contact from info items
      let dateText = '';
      let contactText = '';

      for (const item of fairInfoItems) {
        // Check if this looks like a date (starts with a month name)
        if (!dateText && item.text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/i)) {
          dateText = item.text;
        } else if (item.text.toLowerCase().includes('contact')) {
          contactText = item.text;
        } else if (!dateText) {
          // Use first item as date if nothing else matches
          dateText = item.text;
        }
      }

      // Parse the date
      const { start, end, datesConfirmed } = parseDateRange(dateText, pageYear);

      const sourceId = createSlugFromName(fair.text);
      const website = fairWebsite?.url;

      // Create venue from fair name
      const venue: ScrapedVenue = {
        name: fair.text.replace(/\s*\([^)]+\)\s*/g, '').trim(),
        state: config.state,
      };

      events.push({
        sourceId,
        sourceName: config.sourceName,
        sourceUrl: config.url,
        name: fair.text,
        startDate: start || undefined,
        endDate: end || undefined,
        datesConfirmed,
        description: contactText ? `Contact: ${contactText.replace(/Contact:\s*/i, '').trim()}` : undefined,
        website,
        ticketUrl: website,
        venue,
        state: config.state,
      });
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

// Vermont Fairs scraper
export async function scrapeVtFairs(): Promise<ScrapeResult> {
  return scrapeVtNhFairsPage({
    url: "https://www.vtnhfairs.org/copy-of-fairs",
    sourceName: "vtnhfairs.org-vt",
    state: "VT",
  });
}

// New Hampshire Fairs scraper
export async function scrapeNhFairs(): Promise<ScrapeResult> {
  return scrapeVtNhFairsPage({
    url: "https://www.vtnhfairs.org/copy-of-fairs-1",
    sourceName: "vtnhfairs.org-nh",
    state: "NH",
  });
}

// Legacy function for backwards compatibility
export async function scrapeVtNhFairs(): Promise<ScrapeResult> {
  return scrapeVtFairs();
}

// Fetch additional details from an event's website (minimal for vtnhfairs since we have most info)
// Returns empty object because all data is already in the initial scrape - we don't want to overwrite
// the correct website URL with the listing page URL
export async function scrapeVtNhEventDetails(_eventUrl: string): Promise<Partial<ScrapedEvent>> {
  return {};
}
