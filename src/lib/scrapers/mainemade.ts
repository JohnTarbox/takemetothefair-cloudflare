// Scraper for mainemade.com events
// Extracts event data from their events page with pagination support

import type { ScrapedEvent, ScrapeResult } from "./types";
import {
  decodeHtmlEntities,
  monthNameToMidnightUtc,
  parseTimeRange,
  expandDateRange,
} from "./utils";
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { SCRAPER_USER_AGENT } from "@takemetothefair/constants";

const SOURCE_NAME = "mainemade.com";
const BASE_URL = "https://www.mainemade.com/events/";
const MAX_PAGES = 10; // Safety limit

// Parse events from HTML. Exported for unit testing — the function is pure
// (HTML in → events out, no I/O).
export function parseEventsFromHtml(html: string): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];

  // Split by event item divs - the site uses "all_events__container__item" class
  const itemPattern = /<div[^>]*class="all_events__container__item"[^>]*>/gi;
  const parts = html.split(itemPattern);

  // Process each part (skip first which is before first item)
  for (let i = 1; i < parts.length; i++) {
    const content = parts[i];

    // Extract event URL from anchor tag with /event/ in href
    const urlMatch = content.match(
      /<a[^>]*href="(https?:\/\/www\.mainemade\.com\/event\/([^"]+))"[^>]*>/i
    );
    if (!urlMatch) continue;

    const eventUrl = urlMatch[1];
    const slug = urlMatch[2].replace(/\/$/, "");

    // Skip if we already have this event
    if (events.some((e) => e.sourceId === slug)) continue;

    // Extract event name from title div
    const titleMatch = content.match(
      /<div[^>]*class="all_events__container__item__content__title"[^>]*>([^<]+)<\/div>/i
    );
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
    const dateContainerMatch = content.match(
      /<div[^>]*class="all_events__container__item__content__date"[^>]*>([\s\S]*?)<\/div>/i
    );

    const dateText = startDateMatch ? startDateMatch[1] : "";
    const fullDateContent = dateContainerMatch
      ? dateContainerMatch[1].replace(/<[^>]+>/g, " ").trim()
      : "";

    // Pattern: "February 7 @ 2:00 PM - 7:00 PM" or "March 21 - March 22"
    //
    // startDate/endDate are stored as date-only midnight UTC anchors per the
    // project convention. Wall-clock time-of-day (e.g. "@ 2:00 PM") goes
    // into eventDays as "HH:MM" strings — venue-zone-agnostic; conversion to
    // UTC happens at render time via parseWallClockInVenueZone (P3b).
    let eventDaysExtracted: ScrapedEvent["eventDays"];
    const dateMatch = (dateText || fullDateContent).match(
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i
    );
    if (dateMatch) {
      const year = new Date().getUTCFullYear();
      const monthName = dateMatch[1];
      const day = parseInt(dateMatch[2]);

      const parsedStart = monthNameToMidnightUtc(monthName, day, year);
      if (parsedStart) {
        startDate = parsedStart;
        // Check for end date from itemprop span first
        if (endDateSpanMatch) {
          const endDateText = endDateSpanMatch[1];
          const endDateParsed = endDateText.match(
            /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i
          );
          if (endDateParsed) {
            const parsedEnd = monthNameToMidnightUtc(
              endDateParsed[1],
              parseInt(endDateParsed[2]),
              year
            );
            if (parsedEnd) endDate = parsedEnd;
          }
        }

        // Fallback: single-day event when no separate endDate span.
        if (!endDate) {
          endDate = new Date(parsedStart);
        }

        // Extract per-day open/close hours from the source. The
        // fullDateContent string typically reads "February 7 @ 2:00 PM -
        // 7:00 PM". parseTimeRange returns null if the source has no
        // time info OR the hours are ambiguous — in either case we skip
        // emitting eventDays and let the admin fill in manually.
        const timeRange = parseTimeRange(fullDateContent);
        if (timeRange) {
          const dates = expandDateRange(startDate, endDate);
          eventDaysExtracted = dates.map((date) => ({
            date,
            openTime: timeRange.openTime,
            closeTime: timeRange.closeTime,
          }));
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
      ...(eventDaysExtracted ? { eventDays: eventDaysExtracted } : {}),
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

      const response = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": SCRAPER_USER_AGENT,
        },
        timeoutMs: 15000,
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
export async function scrapeMaineMadeEventDetails(
  eventUrl: string
): Promise<Partial<ScrapedEvent>> {
  try {
    const response = await fetchWithTimeout(eventUrl, {
      headers: {
        "User-Agent": SCRAPER_USER_AGENT,
      },
      timeoutMs: 15000,
    });

    if (!response.ok) {
      return {};
    }

    const html = await response.text();
    const details: Partial<ScrapedEvent> = {};

    // Try to extract from JSON-LD structured data first (most reliable)
    const jsonLdMatch = html.match(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
    );
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
                  .slice(0, 5000);
              }
              if (item.image && !details.imageUrl) {
                details.imageUrl = typeof item.image === "string" ? item.image : item.image?.url;
              }
              if (item.location) {
                if (typeof item.location === "object") {
                  details.location = item.location.name;
                  if (item.location.address) {
                    const addr =
                      typeof item.location.address === "string"
                        ? { streetAddress: item.location.address }
                        : item.location.address;

                    details.city = addr.addressLocality;
                    details.state = addr.addressRegion || "ME";
                    details.address = [
                      addr.streetAddress,
                      addr.addressLocality,
                      addr.addressRegion,
                      addr.postalCode,
                    ]
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
      const ogDescMatch = html.match(
        /<meta[^>]*property="og:description"[^>]*content="([^"]+)"[^>]*>/i
      );
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
      const websiteMatch = html.match(
        /<a[^>]*href="(https?:\/\/(?!www\.mainemade\.com)[^"]+)"[^>]*>[^<]*(?:more information|website|visit|register|tickets)[^<]*<\/a>/i
      );
      if (websiteMatch) {
        details.website = websiteMatch[1];
      }
    }

    // Extract venue/location from HTML if not found in JSON-LD
    if (!details.location) {
      const venueMatch = html.match(
        /<span[^>]*class="[^"]*tribe-venue[^"]*"[^>]*>([^<]+)<\/span>/i
      );
      if (venueMatch) {
        details.location = venueMatch[1].trim();
      }
    }

    return details;
  } catch {
    return {};
  }
}
