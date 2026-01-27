// Scraper for fairsandfestivals.net
// Extracts event data from state listing pages (e.g., /states/ME)

import { decodeHtmlEntities, type ScrapedEvent, type ScrapeResult, type ScrapedVenue } from "./mainefairs";

const SOURCE_NAME = "fairsandfestivals.net";
const BASE_URL = "https://www.fairsandfestivals.net";

// Month name to number mapping
const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parse a date from the fairsandfestivals.net format
 * The page has: <span class="month">February</span> 01 <span class="year">2026</span>
 */
function parseEventDate(month: string, day: string, year: string): Date | null {
  const monthNum = MONTH_MAP[month.toLowerCase()];
  if (monthNum === undefined) return null;

  const dayNum = parseInt(day, 10);
  const yearNum = parseInt(year, 10);

  if (isNaN(dayNum) || isNaN(yearNum)) return null;

  const date = new Date(yearNum, monthNum, dayNum);
  if (isNaN(date.getTime())) return null;

  return date;
}

/**
 * Extract state code from state name
 */
function getStateCode(stateName: string): string {
  const stateMap: Record<string, string> = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
    california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
    florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
    illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
    kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
    massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
    missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
    vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
    wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
  };

  const normalized = stateName.toLowerCase().trim();

  // If already a 2-letter code, return uppercase
  if (/^[a-z]{2}$/i.test(normalized)) {
    return normalized.toUpperCase();
  }

  return stateMap[normalized] || normalized.substring(0, 2).toUpperCase();
}

/**
 * Extract event slug from URL like "/events/details/2026-portland-wedding-show"
 */
function extractSlugFromUrl(url: string): string {
  const match = url.match(/\/events\/details\/([^/]+)/);
  return match ? match[1] : url.replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

/**
 * Scrape events from a fairsandfestivals.net state page
 * @param stateCode Two-letter state code (e.g., "ME" for Maine)
 */
export async function scrapeFairsAndFestivals(stateCode: string): Promise<ScrapeResult> {
  const url = `${BASE_URL}/states/${stateCode.toUpperCase()}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TakeMeToTheFair/1.0)',
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
    return parseEventsFromHtml(html, stateCode, url);
  } catch (error) {
    return {
      success: false,
      events: [],
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Parse events from HTML content
 */
export function parseEventsFromHtml(html: string, defaultState: string, sourceUrl: string): ScrapeResult {
  const events: ScrapedEvent[] = [];

  // Split the HTML by event div markers
  // Pattern: <div class="event">
  const eventSections = html.split(/<div\s+class="event">/i);

  // Skip the first section (content before first event)
  for (let i = 1; i < eventSections.length; i++) {
    const section = eventSections[i];

    try {
      // Extract event name from h4 tag
      const nameMatch = section.match(/<h4>([^<]+)<\/h4>/i);
      if (!nameMatch) continue;
      const name = decodeHtmlEntities(nameMatch[1].trim());
      if (!name) continue;

      // Extract date components
      const monthMatch = section.match(/<span\s+class="month">([^<]+)<\/span>/i);
      const yearMatch = section.match(/<span\s+class="year">([^<]+)<\/span>/i);

      // Day is between month and year spans - look for digits
      const dateBlockMatch = section.match(/<p\s+class="date">([\s\S]*?)<\/p>/i);
      let day = "1";
      if (dateBlockMatch) {
        const dayMatch = dateBlockMatch[1].match(/<\/span>\s*(\d{1,2})/i);
        if (dayMatch) {
          day = dayMatch[1];
        }
      }

      const month = monthMatch ? monthMatch[1].trim() : "";
      const year = yearMatch ? yearMatch[1].trim() : String(new Date().getFullYear());

      // Parse the date
      const eventDate = month ? parseEventDate(month, day, year) : null;

      // Extract location info
      const cityMatch = section.match(/<span\s+class="city">([^<]+)<\/span>/i);
      const stateMatch = section.match(/<span\s+class="state">([^<]+)<\/span>/i);

      // Venue name is text after state span in the location cell
      // Pattern: <span class="state">ME</span> Venue Name
      let venueName = "";
      const locationCellMatch = section.match(/<td\s+class="location">([\s\S]*?)<\/td>/i);
      if (locationCellMatch) {
        // Remove the city and state spans, get remaining text
        const locationText = locationCellMatch[1]
          .replace(/<span[^>]*>[^<]*<\/span>/gi, '')
          .replace(/,/g, '')
          .trim();
        if (locationText) {
          venueName = decodeHtmlEntities(locationText);
        }
      }

      const city = cityMatch ? decodeHtmlEntities(cityMatch[1].trim()) : undefined;
      const state = stateMatch ? getStateCode(stateMatch[1].trim()) : defaultState.toUpperCase();

      // Extract description
      let description = "";
      const descMatch = section.match(/<td\s+class="field-name">Description:<\/td>\s*<td>([\s\S]*?)<\/td>/i);
      if (descMatch) {
        description = descMatch[1]
          .replace(/<a[^>]*>.*?<\/a>/gi, '') // Remove "View more detail" links
          .replace(/<[^>]+>/g, '') // Remove remaining HTML tags
          .replace(/\s+/g, ' ')
          .trim();
        description = decodeHtmlEntities(description);
        if (description.length > 500) {
          description = description.substring(0, 497) + "...";
        }
      }

      // Extract event detail URL
      let detailUrl = "";
      const detailMatch = section.match(/<a\s+href="(\/events\/details\/[^"]+)"[^>]*>View more detail/i);
      if (detailMatch) {
        detailUrl = BASE_URL + detailMatch[1];
      }

      // Extract vendor types (Art, Craft, Food, Commercial, etc.)
      const vendorTypes: string[] = [];
      const vendorTypesMatch = section.match(/<td\s+class="field-name">Types of Vendor:<\/td>\s*<td>([\s\S]*?)<\/td>/i);
      if (vendorTypesMatch) {
        // The vendor types are listed as text, one per line
        const typesText = vendorTypesMatch[1]
          .replace(/<[^>]+>/g, '') // Remove any HTML tags
          .trim();
        // Split by whitespace and filter out empty strings
        const types = typesText.split(/\s+/).filter(t => t.length > 0);
        vendorTypes.push(...types);
      }

      // Check if commercial vendors are allowed
      const commercialVendorsAllowed = vendorTypes.some(
        t => t.toLowerCase() === 'commercial'
      );

      // Generate source ID from the detail URL or event name
      const sourceId = detailUrl ? extractSlugFromUrl(detailUrl) :
                       name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');

      // Build venue object if we have enough info
      const venue: ScrapedVenue | undefined = venueName || city ? {
        name: venueName || `${city || 'Unknown'} Venue`,
        city,
        state,
      } : undefined;

      events.push({
        sourceId,
        sourceName: SOURCE_NAME,
        sourceUrl: detailUrl || sourceUrl,
        name,
        startDate: eventDate || undefined,
        endDate: eventDate || undefined, // Single day event, will be refined with details
        datesConfirmed: !!eventDate,
        description: description || undefined,
        location: venueName || undefined,
        city,
        state,
        venue,
        ticketUrl: detailUrl || undefined,
        vendorTypes: vendorTypes.length > 0 ? vendorTypes : undefined,
        commercialVendorsAllowed,
      });
    } catch (error) {
      // Skip this event if parsing fails
      console.error(`[FairsAndFestivals] Error parsing event:`, error);
      continue;
    }
  }

  return {
    success: true,
    events,
  };
}

/**
 * Scrape additional details from an event's detail page
 */
export async function scrapeEventDetails(detailUrl: string): Promise<Partial<ScrapedEvent>> {
  try {
    const response = await fetch(detailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TakeMeToTheFair/1.0)',
      },
    });

    if (!response.ok) {
      return {};
    }

    const html = await response.text();
    const details: Partial<ScrapedEvent> = {};

    // Extract og:image for event image
    const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
                         html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i);
    if (ogImageMatch) {
      details.imageUrl = ogImageMatch[1];
    }

    // Extract full description
    const descMatch = html.match(/<div[^>]*class="[^"]*event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (descMatch) {
      const fullDesc = descMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (fullDesc.length > 50) {
        details.description = decodeHtmlEntities(fullDesc.substring(0, 2000));
      }
    }

    // Look for date range (e.g., "March 21-22, 2026")
    const dateRangeMatch = html.match(/(\w+)\s+(\d+)\s*[-–]\s*(\d+),?\s*(\d{4})/i);
    if (dateRangeMatch) {
      const month = dateRangeMatch[1];
      const startDay = dateRangeMatch[2];
      const endDay = dateRangeMatch[3];
      const year = dateRangeMatch[4];

      const startDate = parseEventDate(month, startDay, year);
      const endDate = parseEventDate(month, endDay, year);

      if (startDate) details.startDate = startDate;
      if (endDate) details.endDate = endDate;
    }

    // Extract website URL if present
    const websiteMatch = html.match(/Website:?\s*<a[^>]*href=["']([^"']+)["'][^>]*>/i);
    if (websiteMatch) {
      details.website = websiteMatch[1];
    }

    // Extract address if available
    const addressMatch = html.match(/Address:?\s*([^<]+)/i);
    if (addressMatch) {
      details.address = decodeHtmlEntities(addressMatch[1].trim());
    }

    return details;
  } catch (error) {
    console.error(`[FairsAndFestivals] Error fetching details:`, error);
    return {};
  }
}

/**
 * Scrape all events from multiple states
 */
export async function scrapeMultipleStates(stateCodes: string[]): Promise<ScrapeResult> {
  const allEvents: ScrapedEvent[] = [];
  const errors: string[] = [];

  for (const stateCode of stateCodes) {
    const result = await scrapeFairsAndFestivals(stateCode);
    if (result.success) {
      allEvents.push(...result.events);
    } else if (result.error) {
      errors.push(`${stateCode}: ${result.error}`);
    }
  }

  return {
    success: errors.length === 0,
    events: allEvents,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

// Export for use in admin import page
export { decodeHtmlEntities };
