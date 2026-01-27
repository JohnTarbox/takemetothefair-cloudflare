// Scraper for mainemade.com events
// Extracts event data from their events page with pagination support

import { ScrapedEvent, ScrapedVenue, ScrapeResult, decodeHtmlEntities } from "./mainefairs";

const SOURCE_NAME = "mainemade.com";
const BASE_URL = "https://www.mainemade.com/events/";
const MAX_PAGES = 10; // Safety limit

// Extract event slug from URL like /event/midcoast-winter-artisan-fair/
function extractSlugFromUrl(url: string): string {
  const match = url.match(/\/event\/([^/]+)/);
  return match ? match[1].replace(/\/$/, "") : url.replace(/[^a-z0-9]/gi, "-").toLowerCase();
}

// Parse events from HTML
function parseEventsFromHtml(html: string): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];

  // Split by event item divs - the site uses "all_events__container__item" class
  const itemPattern = /<div[^>]*class="all_events__container__item"[^>]*>/gi;
  const parts = html.split(itemPattern);

  // Process each part (skip first which is before first item)
  for (let i = 1; i < parts.length; i++) {
    const content = parts[i];

    // Extract event URL from anchor tag with /event/ in href
    const urlMatch = content.match(/<a[^>]*href="(https?:\/\/www\.mainemade\.com\/event\/([^"]+))"[^>]*>/i);
    if (!urlMatch) continue;

    const eventUrl = urlMatch[1];
    const slug = urlMatch[2].replace(/\/$/, "");

    // Skip if we already have this event
    if (events.some((e) => e.sourceId === slug)) continue;

    // Extract event name from title div
    const titleMatch = content.match(/<div[^>]*class="all_events__container__item__content__title"[^>]*>([^<]+)<\/div>/i);
    const eventName = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : "";

    if (!eventName || eventName.length < 3) continue;

    // Try to extract date from the date div or span with itemprop="startDate"
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    // First try itemprop="startDate" span
    const startDateMatch = content.match(/<span[^>]*itemprop="startDate"[^>]*>([^<]+)<\/span>/i);
    // Also look for endDate span
    const endDateSpanMatch = content.match(/<span[^>]*itemprop="endDate"[^>]*>([^<]+)<\/span>/i);
    // Also look for the full date div content for time info
    const dateContainerMatch = content.match(/<div[^>]*class="all_events__container__item__content__date"[^>]*>([\s\S]*?)<\/div>/i);

    const dateText = startDateMatch ? startDateMatch[1] : "";
    const fullDateContent = dateContainerMatch ? dateContainerMatch[1].replace(/<[^>]+>/g, " ").trim() : "";

    // Pattern: "February 7 @ 2:00 PM - 7:00 PM" or "March 21 - March 22"
    const dateMatch = (dateText || fullDateContent).match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
    if (dateMatch) {
      const year = new Date().getFullYear();
      const month = dateMatch[1];
      const day = dateMatch[2];

      startDate = new Date(`${month} ${day}, ${year}`);
      if (!isNaN(startDate.getTime())) {
        // Check for time in full content
        const timeMatch = fullDateContent.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (timeMatch) {
          let hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          if (timeMatch[3].toUpperCase() === "PM" && hours < 12) hours += 12;
          if (timeMatch[3].toUpperCase() === "AM" && hours === 12) hours = 0;
          startDate.setHours(hours, minutes, 0, 0);
        } else {
          startDate.setHours(9, 0, 0, 0);
        }

        // Check for end date from itemprop span first
        if (endDateSpanMatch) {
          const endDateText = endDateSpanMatch[1];
          const endDateParsed = endDateText.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
          if (endDateParsed) {
            endDate = new Date(`${endDateParsed[1]} ${endDateParsed[2]}, ${year}`);
            endDate.setHours(21, 0, 0, 0);
          }
        }

        // If no end date from span, check for end time
        if (!endDate) {
          const endTimeMatch = fullDateContent.match(/[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (endTimeMatch) {
            endDate = new Date(startDate);
            let endHours = parseInt(endTimeMatch[1]);
            const endMinutes = parseInt(endTimeMatch[2]);
            if (endTimeMatch[3].toUpperCase() === "PM" && endHours < 12) endHours += 12;
            if (endTimeMatch[3].toUpperCase() === "AM" && endHours === 12) endHours = 0;
            endDate.setHours(endHours, endMinutes, 0, 0);
          } else {
            endDate = new Date(startDate);
            endDate.setHours(21, 0, 0, 0);
          }
        }
      }
    }

    // Extract image URL - prefer data-lazy-src for actual image, fallback to src if not a placeholder
    let imageUrl: string | undefined;
    const lazyImgMatch = content.match(/<img[^>]*data-lazy-src="([^"]+)"[^>]*>/i);
    if (lazyImgMatch) {
      imageUrl = lazyImgMatch[1];
    } else {
      const imgMatch = content.match(/<img[^>]*src="([^"]+)"[^>]*>/i);
      if (imgMatch && !imgMatch[1].includes("data:image")) {
        imageUrl = imgMatch[1];
      }
    }

    events.push({
      sourceId: slug,
      sourceName: SOURCE_NAME,
      sourceUrl: eventUrl,
      name: eventName,
      startDate,
      endDate,
      datesConfirmed: !!startDate,
      imageUrl,
      ticketUrl: eventUrl,
      state: "ME",
    });
  }

  return events;
}

// Check if there's a next page
function hasNextPage(html: string, currentPage: number): boolean {
  // Look for "NEXT" link or page number links
  const nextPattern = new RegExp(`/events/page/${currentPage + 1}/|class="[^"]*next[^"]*"`, "i");
  return nextPattern.test(html);
}

export async function scrapeMaineMade(): Promise<ScrapeResult> {
  try {
    const allEvents: ScrapedEvent[] = [];
    let currentPage = 1;

    while (currentPage <= MAX_PAGES) {
      const url = currentPage === 1 ? BASE_URL : `${BASE_URL}page/${currentPage}/`;

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)",
        },
      });

      if (!response.ok) {
        if (currentPage === 1) {
          return {
            success: false,
            events: [],
            error: `Failed to fetch events page: ${response.status} ${response.statusText}`,
          };
        }
        // No more pages
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

      // Check for next page
      if (!hasNextPage(html, currentPage)) {
        break;
      }

      currentPage++;
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
export async function scrapeMaineMadeEventDetails(eventUrl: string): Promise<Partial<ScrapedEvent>> {
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

    // Try to extract from JSON-LD structured data first (most reliable)
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
                    const addr = typeof item.location.address === "string"
                      ? { streetAddress: item.location.address }
                      : item.location.address;

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
                } else if (typeof item.location === "string") {
                  details.location = item.location;
                }
              }
              // Extract URL if available (external website)
              if (item.url && !details.website && !item.url.includes("mainemade.com")) {
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
      // Look for event content/description area
      const descPatterns = [
        /<div[^>]*class="[^"]*tribe-events-single-event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class="[^"]*event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
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
        details.description = ogDescMatch[1]
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/&#8217;/g, "'");
      }
    }

    // Try to extract external website link
    if (!details.website) {
      // Look for "Click For More Information" or similar links
      const websiteMatch = html.match(/<a[^>]*href="(https?:\/\/(?!www\.mainemade\.com)[^"]+)"[^>]*>[^<]*(?:more information|website|visit|register|tickets)[^<]*<\/a>/i);
      if (websiteMatch) {
        details.website = websiteMatch[1];
      }
    }

    // Extract venue/location from HTML if not found in JSON-LD
    if (!details.location) {
      const venueMatch = html.match(/<span[^>]*class="[^"]*tribe-venue[^"]*"[^>]*>([^<]+)<\/span>/i);
      if (venueMatch) {
        details.location = venueMatch[1].trim();
      }
    }

    return details;
  } catch {
    return {};
  }
}
