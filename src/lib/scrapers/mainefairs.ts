// Scraper for mainefairs.net
// Extracts fair/event data from their calendar page

// Decode common HTML entities
export function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export interface ScrapedVenue {
  name: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface ScrapedEvent {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  name: string;
  startDate?: Date;
  endDate?: Date;
  datesConfirmed?: boolean;
  description?: string;
  location?: string;
  city?: string;
  state?: string;
  address?: string;
  imageUrl?: string;
  ticketUrl?: string;
  website?: string;
  venue?: ScrapedVenue;
  commercialVendorsAllowed?: boolean;
  vendorTypes?: string[]; // e.g., ["Art", "Craft", "Food", "Commercial"]
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
      const eventName = linkMatch ? decodeHtmlEntities(linkMatch[2].trim()) : "";

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
        const eventName = decodeHtmlEntities(match[3].trim());

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

    // First, try to extract dates from JSON-LD structured data (most reliable)
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const match of jsonLdMatch) {
        try {
          const jsonContent = match.replace(/<script[^>]*>|<\/script>/gi, '').trim();
          const data = JSON.parse(jsonContent);

          // Handle both single object and array of objects
          const items = Array.isArray(data) ? data : [data];

          for (const item of items) {
            if (item['@type'] === 'Event' || item.startDate) {
              if (item.startDate) {
                const start = new Date(item.startDate);
                if (!isNaN(start.getTime())) {
                  details.startDate = start;
                }
              }
              if (item.endDate) {
                const end = new Date(item.endDate);
                if (!isNaN(end.getTime())) {
                  details.endDate = end;
                }
              }
              if (item.description && !details.description) {
                details.description = String(item.description).slice(0, 2000);
              }
              if (item.image && !details.imageUrl) {
                details.imageUrl = typeof item.image === 'string' ? item.image : item.image?.url;
              }
              if (item.location) {
                if (typeof item.location === 'object') {
                  details.location = item.location.name;
                  if (item.location.address) {
                    const addr = item.location.address;
                    details.city = addr.addressLocality;
                    details.state = addr.addressRegion;
                    details.address = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
                      .filter(Boolean)
                      .join(', ');

                    // Build venue object with full details
                    details.venue = {
                      name: item.location.name || details.location || '',
                      streetAddress: addr.streetAddress,
                      city: addr.addressLocality,
                      state: addr.addressRegion,
                      zip: addr.postalCode,
                    };
                  } else if (item.location.name) {
                    // Location without detailed address
                    details.venue = {
                      name: item.location.name,
                      state: 'ME', // Default to Maine for mainefairs.net
                    };
                  }
                }
              }
              // Extract website URL from JSON-LD if available (skip mainefairs.net URLs)
              if (item.url && !details.website && !item.url.includes('mainefairs.net')) {
                details.website = item.url;
              }
              break;
            }
          }
        } catch {
          // JSON parse failed, continue to next match
        }
      }
    }

    // Fallback: Try to extract description from HTML if not found in JSON-LD
    if (!details.description) {
      const descMatch = html.match(/<div[^>]*class="[^"]*tribe-events-single-event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (descMatch) {
        details.description = descMatch[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2000);
      }
    }

    // Fallback: Try to extract venue/location from HTML
    if (!details.location) {
      const venueMatch = html.match(/<span[^>]*class="[^"]*tribe-venue[^"]*"[^>]*>([^<]+)<\/span>/i);
      if (venueMatch) {
        details.location = venueMatch[1].trim();
      }
    }

    // Fallback: Try to get image from og:image
    if (!details.imageUrl) {
      const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"[^>]*>/i);
      if (ogImageMatch) {
        details.imageUrl = ogImageMatch[1];
      }
    }

    // Extract website from HTML - look for "Website:" label followed by a link
    if (!details.website) {
      // Pattern 1: tribe-events-event-url span containing the link (mainefairs.net specific)
      // <span class="tribe-events-event-url tribe-events-meta-value"> <a href="...">
      const tribeUrlMatch = html.match(/<span[^>]*class="[^"]*tribe-events-event-url\s+tribe-events-meta-value[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"/i);
      if (tribeUrlMatch) {
        details.website = tribeUrlMatch[1];
      } else {
        // Pattern 2: Look for Website: label then find next anchor href (handles newlines)
        const websiteSectionMatch = html.match(/Website:?<\/span>[\s\S]*?<a[^>]*href="([^"]+)"/i);
        if (websiteSectionMatch && !websiteSectionMatch[1].includes('mainefairs.net')) {
          details.website = websiteSectionMatch[1];
        } else {
          // Pattern 3: "Website:" followed by closing tag then anchor tag
          const websiteMatch = html.match(/Website:?\s*<\/?\w+[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>/i);
          if (websiteMatch) {
            details.website = websiteMatch[1];
          } else {
            // Pattern 4: dt/dd pattern for Website
            const dtDdMatch = html.match(/<dt[^>]*>Website:?<\/dt>\s*<dd[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>/i);
            if (dtDdMatch) {
              details.website = dtDdMatch[1];
            } else {
              // Pattern 5: Simple "Website:" text followed by link on same line
              const simpleMatch = html.match(/Website:?\s*<a[^>]*href="([^"]+)"[^>]*>/i);
              if (simpleMatch) {
                details.website = simpleMatch[1];
              }
            }
          }
        }
      }
    }

    // Fallback: Extract dates from visible text if JSON-LD didn't work
    if (!details.startDate || !details.endDate) {
      const dateMatch = html.match(/(\w+\s+\d+,?\s*\d*)\s*[-–]\s*(\w+\s+\d+,?\s*\d*)/i);
      if (dateMatch) {
        const year = new Date().getFullYear();
        const startStr = dateMatch[1].includes(',') ? dateMatch[1] : `${dateMatch[1]}, ${year}`;
        const endStr = dateMatch[2].includes(',') ? dateMatch[2] : `${dateMatch[2]}, ${year}`;

        if (!details.startDate) {
          const start = new Date(startStr);
          if (!isNaN(start.getTime())) {
            start.setHours(9, 0, 0, 0);
            details.startDate = start;
          }
        }
        if (!details.endDate) {
          const end = new Date(endStr);
          if (!isNaN(end.getTime())) {
            end.setHours(21, 0, 0, 0);
            details.endDate = end;
          }
        }
      }
    }

    return details;
  } catch {
    return {};
  }
}
