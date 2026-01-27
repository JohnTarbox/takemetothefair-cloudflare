// Scraper for mainepublic.org community calendar
// Extracts event data from their community calendar page

import { ScrapedEvent, ScrapedVenue, ScrapeResult } from "./mainefairs";

const SOURCE_NAME = "mainepublic.org";
const CALENDAR_URL = "https://www.mainepublic.org/community-calendar";
const MAX_PAGES = 10; // Limit pages to scrape

// Parse date strings like "February 15, 2026" or "Feb 15"
function parseDate(dateText: string, year?: number): Date | null {
  const cleaned = dateText.trim();
  const currentYear = year || new Date().getFullYear();

  // Try parsing as-is first
  let date = new Date(cleaned);
  if (!isNaN(date.getTime())) {
    return date;
  }

  // Try adding year if not present
  if (!cleaned.match(/\d{4}/)) {
    date = new Date(`${cleaned}, ${currentYear}`);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

// Parse time string like "03:00 PM" to hours and minutes
function parseTime(timeText: string): { hours: number; minutes: number } | null {
  const match = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3]?.toUpperCase();

  if (period === "PM" && hours < 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;

  return { hours, minutes };
}

// Extract event slug from URL
function extractSlugFromUrl(url: string): string {
  const match = url.match(/\/event\/([^/?]+)/);
  return match ? match[1] : url.replace(/[^a-z0-9]/gi, "-").toLowerCase();
}

// Parse the HTML to extract events
function parseEventsFromHtml(html: string): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];

  // Look for event cards/links
  // Pattern: event links with format /community-calendar/event/slug
  const eventLinkPattern = /<a[^>]*href="(https?:\/\/www\.mainepublic\.org\/community-calendar\/event\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;

  // Also look for event containers that have more structured data
  // The site uses article or div elements for event cards

  // First, try to find event sections with dates
  const eventSections = html.split(/<article|<div[^>]*class="[^"]*event[^"]*"/i);

  for (let i = 1; i < eventSections.length; i++) {
    const section = eventSections[i];

    // Find event link
    const linkMatch = section.match(/<a[^>]*href="(https?:\/\/www\.mainepublic\.org\/community-calendar\/event\/([^"]+))"[^>]*>([^<]*)<\/a>/i);
    if (!linkMatch) continue;

    const eventUrl = linkMatch[1];
    const slug = linkMatch[2];
    const eventName = linkMatch[3].trim();

    if (!eventName || eventName.length < 3) continue;

    // Check for duplicates
    if (events.some((e) => e.sourceId === slug)) continue;

    // Try to extract date - look for month patterns
    const dateMatch = section.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:\s*,?\s*\d{4})?/i);
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (dateMatch) {
      const parsed = parseDate(dateMatch[0]);
      if (parsed) {
        startDate = parsed;
        startDate.setHours(9, 0, 0, 0);
        endDate = new Date(startDate);
        endDate.setHours(21, 0, 0, 0);
      }
    }

    // Try to extract time
    const timeMatch = section.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (timeMatch && startDate && endDate) {
      const startTime = parseTime(timeMatch[1]);
      const endTime = parseTime(timeMatch[2]);
      if (startTime) {
        startDate.setHours(startTime.hours, startTime.minutes, 0, 0);
      }
      if (endTime) {
        endDate.setHours(endTime.hours, endTime.minutes, 0, 0);
      }
    }

    // Try to extract location
    let location: string | undefined;
    const locationMatch = section.match(/(?:Location|Venue|at|@)[\s:]*([^<\n]+)/i);
    if (locationMatch) {
      location = locationMatch[1].trim().replace(/\s+/g, " ");
    }

    // Try to extract image
    let imageUrl: string | undefined;
    const imgMatch = section.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
    if (imgMatch && !imgMatch[1].includes("data:image")) {
      imageUrl = imgMatch[1];
    }

    events.push({
      sourceId: slug,
      sourceName: SOURCE_NAME,
      sourceUrl: eventUrl,
      name: eventName,
      startDate,
      endDate,
      datesConfirmed: !!startDate,
      location,
      imageUrl,
      ticketUrl: eventUrl,
      state: "ME",
    });
  }

  // Fallback: If structured parsing didn't work, try simple link extraction
  if (events.length === 0) {
    let match;
    const simplePattern = /<a[^>]*href="(https?:\/\/www\.mainepublic\.org\/community-calendar\/event\/([^"]+))"[^>]*>([^<]+)<\/a>/gi;

    while ((match = simplePattern.exec(html)) !== null) {
      const eventUrl = match[1];
      const slug = match[2];
      const eventName = match[3].trim();

      if (!eventName || eventName.length < 3) continue;
      if (events.some((e) => e.sourceId === slug)) continue;

      events.push({
        sourceId: slug,
        sourceName: SOURCE_NAME,
        sourceUrl: eventUrl,
        name: eventName,
        datesConfirmed: false,
        ticketUrl: eventUrl,
        state: "ME",
      });
    }
  }

  return events;
}

export async function scrapeMainePublic(): Promise<ScrapeResult> {
  try {
    const allEvents: ScrapedEvent[] = [];

    // Fetch multiple pages
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? CALENDAR_URL : `${CALENDAR_URL}?page=${page}&p=${page}`;

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)",
        },
      });

      if (!response.ok) {
        if (page === 1) {
          return {
            success: false,
            events: [],
            error: `Failed to fetch calendar page: ${response.status} ${response.statusText}`,
          };
        }
        // Stop if we hit an error on subsequent pages
        break;
      }

      const html = await response.text();
      const pageEvents = parseEventsFromHtml(html);

      // Add unique events
      for (const event of pageEvents) {
        if (!allEvents.some((e) => e.sourceId === event.sourceId)) {
          allEvents.push(event);
        }
      }

      // Check if there are more pages
      if (!html.includes("Next") && !html.includes(`page=${page + 1}`)) {
        break;
      }
    }

    return {
      success: true,
      events: allEvents,
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
export async function scrapeMainePublicEventDetails(eventUrl: string): Promise<Partial<ScrapedEvent>> {
  try {
    const response = await fetch(eventUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)",
      },
    });

    if (!response.ok) {
      return {};
    }

    const html = await response.text();
    const details: Partial<ScrapedEvent> = {};

    // Try to extract from JSON-LD structured data first
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const match of jsonLdMatch) {
        try {
          const jsonContent = match.replace(/<script[^>]*>|<\/script>/gi, "").trim();
          const data = JSON.parse(jsonContent);
          const items = Array.isArray(data) ? data : [data];

          for (const item of items) {
            if (item["@type"] === "Event" || item.startDate) {
              if (item.startDate) {
                const start = new Date(item.startDate);
                if (!isNaN(start.getTime())) {
                  details.startDate = start;
                  details.datesConfirmed = true;
                }
              }
              if (item.endDate) {
                const end = new Date(item.endDate);
                if (!isNaN(end.getTime())) {
                  details.endDate = end;
                }
              }
              if (item.description && !details.description) {
                details.description = String(item.description)
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 2000);
              }
              if (item.image && !details.imageUrl) {
                details.imageUrl = typeof item.image === "string" ? item.image : item.image?.url;
              }
              if (item.location) {
                if (typeof item.location === "object") {
                  details.location = item.location.name;
                  if (item.location.address) {
                    const addr = item.location.address;
                    details.city = addr.addressLocality;
                    details.state = addr.addressRegion || "ME";
                    details.address = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
                      .filter(Boolean)
                      .join(", ");

                    details.venue = {
                      name: item.location.name || details.location || "",
                      streetAddress: addr.streetAddress,
                      city: addr.addressLocality,
                      state: addr.addressRegion || "ME",
                      zip: addr.postalCode,
                    };
                  }
                }
              }
              if (item.url && !details.website && !item.url.includes("mainepublic.org")) {
                details.website = item.url;
              }
              break;
            }
          }
        } catch {
          // JSON parse failed, continue
        }
      }
    }

    // Fallback: Extract description from HTML
    if (!details.description) {
      // Look for description in various common containers
      const descPatterns = [
        /<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<p[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
      ];

      for (const pattern of descPatterns) {
        const match = html.match(pattern);
        if (match) {
          details.description = match[1]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 2000);
          if (details.description.length > 50) break;
        }
      }
    }

    // Extract og:image if no image found
    if (!details.imageUrl) {
      const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"[^>]*>/i);
      if (ogImageMatch) {
        details.imageUrl = ogImageMatch[1];
      }
    }

    // Extract og:description if no description found
    if (!details.description) {
      const ogDescMatch = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"[^>]*>/i);
      if (ogDescMatch) {
        details.description = ogDescMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      }
    }

    // Try to extract ticket/website URL
    if (!details.website) {
      // Look for "Tickets" or external links
      const ticketMatch = html.match(/<a[^>]*href="(https?:\/\/(?!www\.mainepublic\.org)[^"]+)"[^>]*>[^<]*(?:ticket|buy|register|website|visit)[^<]*<\/a>/i);
      if (ticketMatch) {
        details.website = ticketMatch[1];
      }
    }

    // Extract venue/location from HTML if not found in JSON-LD
    if (!details.location) {
      const venueMatch = html.match(/(?:Location|Venue|Where)[\s:]*<[^>]*>([^<]+)</i);
      if (venueMatch) {
        details.location = venueMatch[1].trim();
      }
    }

    // Fallback: Extract date/time from text patterns like "10:00 AM - 12:00 PM on Tue, 27 Jan 2026"
    if (!details.startDate) {
      // Pattern: "HH:MM AM/PM - HH:MM AM/PM on Day, DD Mon YYYY"
      const dateTimePattern = /(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s+on\s+\w+,\s*(\d{1,2})\s+(\w+)\s+(\d{4})/i;
      const dtMatch = html.match(dateTimePattern);
      if (dtMatch) {
        const startTimeStr = dtMatch[1];
        const endTimeStr = dtMatch[2];
        const day = parseInt(dtMatch[3]);
        const monthStr = dtMatch[4];
        const year = parseInt(dtMatch[5]);

        // Parse month
        const months: Record<string, number> = {
          jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
          jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
          january: 0, february: 1, march: 2, april: 3, june: 5,
          july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
        };
        const monthNum = months[monthStr.toLowerCase()];

        if (monthNum !== undefined) {
          const startTime = parseTime(startTimeStr);
          const endTime = parseTime(endTimeStr);

          if (startTime) {
            details.startDate = new Date(year, monthNum, day, startTime.hours, startTime.minutes);
            details.datesConfirmed = true;
          }
          if (endTime) {
            details.endDate = new Date(year, monthNum, day, endTime.hours, endTime.minutes);
          }
        }
      }
    }

    // Additional fallback: "Day, DD Mon YYYY" without time
    if (!details.startDate) {
      const dateOnlyPattern = /\b(\w+),\s*(\d{1,2})\s+(\w{3,})\s+(\d{4})\b/i;
      const dateMatch = html.match(dateOnlyPattern);
      if (dateMatch) {
        const day = parseInt(dateMatch[2]);
        const monthStr = dateMatch[3];
        const year = parseInt(dateMatch[4]);

        const months: Record<string, number> = {
          jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
          jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
          january: 0, february: 1, march: 2, april: 3, june: 5,
          july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
        };
        const monthNum = months[monthStr.toLowerCase()];

        if (monthNum !== undefined) {
          details.startDate = new Date(year, monthNum, day, 9, 0);
          details.endDate = new Date(year, monthNum, day, 17, 0);
          details.datesConfirmed = true;
        }
      }
    }

    return details;
  } catch {
    return {};
  }
}
