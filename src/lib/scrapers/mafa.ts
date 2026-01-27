// Scraper for mafa.org (Massachusetts Agricultural Fairs Association)
// Extracts fair/event data from their fairs by date page

import type { ScrapedEvent, ScrapeResult, ScrapedVenue } from "./mainefairs";
import { decodeHtmlEntities } from "./mainefairs";

// Parse date strings like "July 15-19", "Aug 7-9", "Sept 4-7", "Oct 2-12"
function parseDateRange(dateText: string, year: number): { start: Date; end: Date } | null {
  // Clean up the text
  const cleaned = dateText.trim()
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Month name mapping (handle abbreviations)
  const monthMap: Record<string, string> = {
    'jan': 'January', 'january': 'January',
    'feb': 'February', 'february': 'February',
    'mar': 'March', 'march': 'March',
    'apr': 'April', 'april': 'April',
    'may': 'May',
    'jun': 'June', 'june': 'June',
    'jul': 'July', 'july': 'July',
    'aug': 'August', 'august': 'August',
    'sep': 'September', 'sept': 'September', 'september': 'September',
    'oct': 'October', 'october': 'October',
    'nov': 'November', 'november': 'November',
    'dec': 'December', 'december': 'December',
  };

  // Try to match patterns like "July 15-19" or "Aug 7-9" (same month range)
  const sameMonthMatch = cleaned.match(/(\w+)\s+(\d+)\s*-\s*(\d+)/i);
  if (sameMonthMatch) {
    const monthKey = sameMonthMatch[1].toLowerCase();
    const month = monthMap[monthKey];
    if (month) {
      const startDay = parseInt(sameMonthMatch[2]);
      const endDay = parseInt(sameMonthMatch[3]);

      const start = new Date(`${month} ${startDay}, ${year}`);
      const end = new Date(`${month} ${endDay}, ${year}`);

      start.setHours(9, 0, 0, 0);
      end.setHours(21, 0, 0, 0);

      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        return { start, end };
      }
    }
  }

  // Try single date like "Aug 29" or "Oct 4"
  const singleMatch = cleaned.match(/(\w+)\s+(\d+)$/i);
  if (singleMatch) {
    const monthKey = singleMatch[1].toLowerCase();
    const month = monthMap[monthKey];
    if (month) {
      const day = parseInt(singleMatch[2]);
      const date = new Date(`${month} ${day}, ${year}`);
      date.setHours(9, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(21, 0, 0, 0);

      if (!isNaN(date.getTime())) {
        return { start: date, end: endDate };
      }
    }
  }

  return null;
}

// Create a slug from fair name
function createSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function scrapeMafaFairs(): Promise<ScrapeResult> {
  const SOURCE_NAME = "mafa.org";
  const CALENDAR_URL = "https://www.mafa.org/2026fairsbydate.html";

  try {
    // Fetch the page
    const response = await fetch(CALENDAR_URL, {
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

    // Extract year from URL (2026fairsbydate.html)
    const urlYearMatch = CALENDAR_URL.match(/(\d{4})fairsbydate/i);
    const pageYear = urlYearMatch ? parseInt(urlYearMatch[1]) : new Date().getFullYear();

    // Extract all content spans with font-size: medium
    // Pattern captures the text content inside spans with font-size: medium
    const spanPattern = /<span[^>]*style="[^"]*font-size:\s*medium[^"]*"[^>]*>([^<]*)<\/span>/gi;

    const allSpans: { index: number; text: string }[] = [];
    let match;
    while ((match = spanPattern.exec(html)) !== null) {
      const text = decodeHtmlEntities(match[1]);
      if (text.length > 0 && text !== '*****') {
        allSpans.push({ index: match.index, text });
      }
    }

    // Also extract website URLs
    const websitePattern = /<a[^>]*HREF="([^"]+)"[^>]*>.*?<span[^>]*>([^<]*www\.[^<]*)<\/span>/gi;
    const websiteUrls: { index: number; url: string }[] = [];
    while ((match = websitePattern.exec(html)) !== null) {
      websiteUrls.push({ index: match.index, url: match[1] });
    }

    // Process spans to extract fairs
    // Structure: date, fair name, [website], date, fair name, [website], ...
    let currentDate: { start: Date; end: Date } | null = null;

    for (let i = 0; i < allSpans.length; i++) {
      const span = allSpans[i];
      const text = span.text;

      // Check if this is a date
      const dateMatch = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+/i);
      if (dateMatch) {
        const parsed = parseDateRange(text, pageYear);
        if (parsed) {
          currentDate = parsed;
        }
        continue;
      }

      // Check if this is a website URL (skip it, we'll match it separately)
      if (text.match(/^www\./i) || text.match(/^http/i)) {
        continue;
      }

      // Check if this looks like a fair name (contains "Fair" or location pattern)
      if (text.includes('Fair') || text.includes(' - ') || text.includes('4-H')) {
        if (!currentDate) {
          // No date yet, skip
          continue;
        }

        // Extract fair name and location
        const fairName = text;
        let location = '';
        const locationMatch = text.match(/^(.+?)\s+-\s+(.+)$/);
        if (locationMatch) {
          location = locationMatch[2];
        }

        // Find website URL that appears after this fair name
        const nextSpanIndex = i < allSpans.length - 1 ? allSpans[i + 1].index : Infinity;
        let website: string | undefined;

        // Check next span for website
        if (i + 1 < allSpans.length) {
          const nextText = allSpans[i + 1].text;
          if (nextText.match(/^www\./i)) {
            // Found website in next span, also get the full URL from anchor
            const matchingUrl = websiteUrls.find(
              u => u.index > span.index && u.index < (i + 2 < allSpans.length ? allSpans[i + 2].index : Infinity)
            );
            website = matchingUrl?.url || `http://${nextText}`;
          }
        }

        const sourceId = createSlugFromName(fairName);

        // Create venue from fair name
        const venue: ScrapedVenue = {
          name: fairName.replace(/\s+-\s+.+$/, '').trim(), // Remove location part
          city: location || undefined,
          state: 'MA',
        };

        // Check if we already have this fair (avoid duplicates)
        if (!events.some(e => e.sourceId === sourceId)) {
          events.push({
            sourceId,
            sourceName: SOURCE_NAME,
            sourceUrl: CALENDAR_URL,
            name: fairName,
            startDate: currentDate.start,
            endDate: currentDate.end,
            website,
            ticketUrl: website,
            venue,
            city: location || undefined,
            state: 'MA',
          });
        }
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

// Fetch additional details - minimal for MAFA since all data is in initial scrape
export async function scrapeMafaEventDetails(_eventUrl: string): Promise<Partial<ScrapedEvent>> {
  return {};
}
