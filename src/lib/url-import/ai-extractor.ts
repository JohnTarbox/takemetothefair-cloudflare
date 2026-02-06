import type { ExtractedEventData, ExtractedEvent, FieldConfidence, EventConfidence, PageMetadata } from "./types";

const SYSTEM_PROMPT = `You are an expert at extracting event information from webpage text. You always respond with valid JSON only, no explanations.`;

const MULTI_EVENT_SYSTEM_PROMPT = `You are an expert at extracting multiple event listings from webpage text. You find ALL events mentioned and return them as a JSON array. You always respond with valid JSON only, no explanations.`;

const buildMultiEventPrompt = (content: string, contextInfo: string) => `Extract ALL events from this webpage. The page may contain one event or multiple events. Return a JSON array of events.

${contextInfo}
WEBPAGE CONTENT:
${content}

---
Return a JSON array where each event has these fields (use null for fields not found):

[
  {
    "name": "event title/name",
    "description": "brief description (max 300 chars)",
    "startDate": "YYYY-MM-DD format",
    "endDate": "YYYY-MM-DD format",
    "venueName": "venue or location name",
    "venueAddress": "street address",
    "venueCity": "city",
    "venueState": "2-letter state code (Maine=ME)",
    "ticketUrl": "URL for tickets",
    "ticketPriceMin": number or null,
    "ticketPriceMax": number or null,
    "imageUrl": "image URL"
  }
]

IMPORTANT RULES:
1. Find ALL events on the page - there may be 1, 5, 10, or more events
2. Each event listing should be a separate object in the array
3. Convert ALL dates to YYYY-MM-DD format
4. If the page lists multiple dates for different events, create separate entries
5. If only ONE event exists, still return it as an array with one element
6. Look for event listings, schedules, calendars, or multiple date entries

JSON array response:`;

const buildUserPrompt = (content: string, contextInfo: string) => `Extract event details from this webpage content. Return ONLY a JSON object.

${contextInfo}
WEBPAGE CONTENT:
${content}

---
Find and extract these fields. Use null for any field not found:

{
  "name": "event title/name",
  "description": "event description (max 500 chars)",
  "startDate": "YYYY-MM-DD format (e.g., February 01, 2026 = 2026-02-01)",
  "endDate": "YYYY-MM-DD format",
  "venueName": "venue or location name",
  "venueAddress": "street address",
  "venueCity": "city",
  "venueState": "2-letter state code (Maine=ME, Massachusetts=MA, New Hampshire=NH)",
  "ticketUrl": "URL for tickets",
  "ticketPriceMin": number or null,
  "ticketPriceMax": number or null,
  "imageUrl": "image URL"
}

IMPORTANT PARSING RULES:
1. Page titles often contain: "Event Name | Date Range | Venue" - parse these parts separately
2. Convert ALL dates to YYYY-MM-DD format:
   - "August 2-10, 2025" = startDate: "2025-08-02", endDate: "2025-08-10"
   - "February 01, 2026" = "2026-02-01"
   - "March 15-17, 2025" = startDate: "2025-03-15", endDate: "2025-03-17"
3. Look for venue/location names like "Mount Sunapee Resort", "Fairgrounds", "Convention Center"
4. Extract the event NAME only (not dates or venue) for the "name" field

JSON response:`;

/**
 * Extract event data from content using Cloudflare Workers AI
 */
export async function extractEventData(
  ai: Ai,
  content: string,
  metadata: PageMetadata
): Promise<{ extracted: ExtractedEventData; confidence: FieldConfidence }> {
  // Build context with metadata if available
  let contextInfo = "";
  if (metadata.title) {
    contextInfo += `Page title: ${metadata.title}\n`;
    // Hint about pipe-separated titles
    if (metadata.title.includes("|")) {
      contextInfo += `(Note: Title appears to have parts separated by "|" - parse each part)\n`;
    }
  }

  // Include meta description (often contains dates/times)
  if (metadata.description) {
    contextInfo += `Page description: ${metadata.description}\n`;
  }

  // If we have JSON-LD structured data, include it for better extraction
  if (metadata.jsonLd) {
    contextInfo += `Structured data (JSON-LD):\n${JSON.stringify(metadata.jsonLd, null, 2)}\n\n`;
  }

  // Truncate content if too long (keep first 15KB to stay within context limits)
  const truncatedContent = content.length > 15000
    ? content.substring(0, 15000) + "\n[Content truncated...]"
    : content;

  const userPrompt = buildUserPrompt(truncatedContent, contextInfo);

  // Call Workers AI with Llama 3.1 8B using messages format for better instruction following
  console.log("[AI Extractor] Calling Workers AI, content length:", truncatedContent.length);

  const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 1024,
    temperature: 0.1, // Low temperature for consistent structured output
  });

  // Log raw response for debugging
  const responseText = typeof response === "string"
    ? response
    : (response as { response?: string }).response || "";
  console.log("[AI Extractor] Raw AI response:", responseText.substring(0, 1500));

  // Parse the response
  const extracted = parseAiResponse(response, metadata);
  const confidence = calculateConfidence(extracted, metadata);

  console.log("[AI Extractor] Parsed extraction:", JSON.stringify(extracted, null, 2));

  return { extracted, confidence };
}

/**
 * Extract MULTIPLE events from content using Cloudflare Workers AI
 * This is the preferred method for URL import as pages may contain multiple events
 */
export async function extractMultipleEvents(
  ai: Ai,
  content: string,
  metadata: PageMetadata
): Promise<{ events: ExtractedEvent[]; confidence: EventConfidence }> {
  // Build context with metadata if available
  let contextInfo = "";
  if (metadata.title) {
    contextInfo += `Page title: ${metadata.title}\n`;
    // Hint about pipe-separated titles
    if (metadata.title.includes("|")) {
      contextInfo += `(Note: Title appears to have parts separated by "|" - parse each part)\n`;
    }
  }

  // Include meta description (often contains dates/times)
  if (metadata.description) {
    contextInfo += `Page description: ${metadata.description}\n`;
  }

  // If we have JSON-LD structured data, include it for better extraction
  if (metadata.jsonLd) {
    contextInfo += `Structured data (JSON-LD):\n${JSON.stringify(metadata.jsonLd, null, 2)}\n\n`;
  }

  // Truncate content if too long (keep first 20KB for multi-event to capture more listings)
  const truncatedContent = content.length > 20000
    ? content.substring(0, 20000) + "\n[Content truncated...]"
    : content;

  const userPrompt = buildMultiEventPrompt(truncatedContent, contextInfo);

  // Call Workers AI with Llama 3.1 8B using messages format
  console.log("[AI Extractor Multi] Calling Workers AI, content length:", truncatedContent.length);

  const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: MULTI_EVENT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 4096, // More tokens for multiple events
    temperature: 0.1,
  });

  // Log raw response for debugging
  const responseText = typeof response === "string"
    ? response
    : (response as { response?: string }).response || "";
  console.log("[AI Extractor Multi] Raw AI response:", responseText.substring(0, 2000));

  // Parse the response as array
  const events = parseMultiEventResponse(response, metadata);
  const confidence = calculateMultiEventConfidence(events, metadata);

  console.log("[AI Extractor Multi] Parsed", events.length, "events");

  return { events, confidence };
}

/**
 * Parse AI response expecting an array of events
 */
function parseMultiEventResponse(
  response: AiTextGenerationOutput,
  metadata: PageMetadata
): ExtractedEvent[] {
  const responseText =
    typeof response === "string"
      ? response
      : (response as { response?: string }).response || "";

  if (!responseText) {
    // Fallback to single event from metadata
    return createFallbackEvent(metadata);
  }

  try {
    // Try to find JSON array in the response
    const arrayMatch = responseText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item, index) => sanitizeEventData(item, index, metadata));
      }
    }

    // Try to find single JSON object (AI returned one event not in array)
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      const parsed = JSON.parse(objectMatch[0]);
      // Check if it's a single event object (has name field)
      if (parsed.name || parsed.title) {
        return [sanitizeEventData(parsed, 0, metadata)];
      }
      // Check if it's an object with an events array
      if (parsed.events && Array.isArray(parsed.events)) {
        return parsed.events.map((item: unknown, index: number) =>
          sanitizeEventData(item as Record<string, unknown>, index, metadata)
        );
      }
    }
  } catch (error) {
    console.error("[AI Extractor Multi] JSON parse error:", error);
  }

  // Fallback: create single event from metadata if available
  return createFallbackEvent(metadata);
}

/**
 * Sanitize a single event from AI response
 */
function sanitizeEventData(
  item: Record<string, unknown>,
  index: number,
  metadata: PageMetadata
): ExtractedEvent {
  const event: ExtractedEvent = {
    _extractId: `event-${index}-${Date.now()}`,
    _selected: true, // Default to selected
    name: sanitizeString(item.name || item.title),
    description: sanitizeString(item.description, 500),
    startDate: sanitizeDate(item.startDate || item.start_date || item.date),
    endDate: sanitizeDate(item.endDate || item.end_date),
    venueName: sanitizeString(item.venueName || item.venue_name || item.venue || item.location),
    venueAddress: sanitizeString(item.venueAddress || item.venue_address || item.address),
    venueCity: sanitizeString(item.venueCity || item.venue_city || item.city),
    venueState: sanitizeState(item.venueState || item.venue_state || item.state),
    ticketUrl: sanitizeUrl(item.ticketUrl || item.ticket_url || item.url || item.link),
    ticketPriceMin: sanitizePrice(item.ticketPriceMin || item.ticket_price_min || item.price_min || item.price),
    ticketPriceMax: sanitizePrice(item.ticketPriceMax || item.ticket_price_max || item.price_max),
    imageUrl: sanitizeUrl(item.imageUrl || item.image_url || item.image),
  };

  // Apply metadata fallbacks for first event
  if (index === 0) {
    if (!event.name && metadata.title) {
      event.name = metadata.title;
    }
    if (!event.imageUrl && metadata.ogImage) {
      event.imageUrl = metadata.ogImage;
    }
  }

  // Use og:image as fallback for all events if they have no image
  if (!event.imageUrl && metadata.ogImage) {
    event.imageUrl = metadata.ogImage;
  }

  return event;
}

/**
 * Create fallback event from metadata when AI extraction fails
 */
function createFallbackEvent(metadata: PageMetadata): ExtractedEvent[] {
  if (!metadata.title && !metadata.jsonLd) {
    return [];
  }

  const event: ExtractedEvent = {
    _extractId: `fallback-${Date.now()}`,
    _selected: true,
    name: metadata.title || null,
    description: null,
    startDate: null,
    endDate: null,
    venueName: null,
    venueAddress: null,
    venueCity: null,
    venueState: null,
    ticketUrl: null,
    ticketPriceMin: null,
    ticketPriceMax: null,
    imageUrl: metadata.ogImage || null,
  };

  // Extract from JSON-LD if available
  if (metadata.jsonLd) {
    const ld = metadata.jsonLd;
    if (ld.name) event.name = String(ld.name);
    if (ld.description) event.description = sanitizeString(String(ld.description), 500);
    if (ld.startDate) event.startDate = sanitizeDate(String(ld.startDate));
    if (ld.endDate) event.endDate = sanitizeDate(String(ld.endDate));

    const location = ld.location as Record<string, unknown> | undefined;
    if (location?.name) event.venueName = String(location.name);
  }

  return event.name ? [event] : [];
}

/**
 * Calculate confidence for multiple events
 */
function calculateMultiEventConfidence(
  events: ExtractedEvent[],
  metadata: PageMetadata
): EventConfidence {
  const confidence: EventConfidence = {};
  const hasJsonLd = !!metadata.jsonLd;

  for (const event of events) {
    const eventConf: FieldConfidence = {};

    for (const [key, value] of Object.entries(event)) {
      if (key.startsWith("_")) continue; // Skip internal fields

      if (value === null) {
        eventConf[key] = "low";
      } else if (hasJsonLd) {
        eventConf[key] = "high";
      } else {
        eventConf[key] = "medium";
      }
    }

    confidence[event._extractId] = eventConf;
  }

  return confidence;
}

/**
 * Parse AI response and extract JSON
 */
function parseAiResponse(
  response: AiTextGenerationOutput,
  metadata: PageMetadata
): ExtractedEventData {
  const defaultData: ExtractedEventData = {
    name: null,
    description: null,
    startDate: null,
    endDate: null,
    venueName: null,
    venueAddress: null,
    venueCity: null,
    venueState: null,
    ticketUrl: null,
    ticketPriceMin: null,
    ticketPriceMax: null,
    imageUrl: null,
  };

  // Get the response text
  const responseText =
    typeof response === "string"
      ? response
      : (response as { response?: string }).response || "";

  if (!responseText) {
    return fallbackFromMetadata(defaultData, metadata);
  }

  try {
    // Try to find JSON in the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fallbackFromMetadata(defaultData, metadata);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and sanitize each field
    const extracted: ExtractedEventData = {
      name: sanitizeString(parsed.name),
      description: sanitizeString(parsed.description, 500),
      startDate: sanitizeDate(parsed.startDate),
      endDate: sanitizeDate(parsed.endDate),
      venueName: sanitizeString(parsed.venueName),
      venueAddress: sanitizeString(parsed.venueAddress),
      venueCity: sanitizeString(parsed.venueCity),
      venueState: sanitizeState(parsed.venueState),
      ticketUrl: sanitizeUrl(parsed.ticketUrl),
      ticketPriceMin: sanitizePrice(parsed.ticketPriceMin),
      ticketPriceMax: sanitizePrice(parsed.ticketPriceMax),
      imageUrl: sanitizeUrl(parsed.imageUrl),
    };

    // Apply metadata fallbacks
    return fallbackFromMetadata(extracted, metadata);
  } catch {
    // JSON parsing failed, try to extract from metadata
    return fallbackFromMetadata(defaultData, metadata);
  }
}

/**
 * Apply metadata as fallback for missing fields
 */
function fallbackFromMetadata(
  data: ExtractedEventData,
  metadata: PageMetadata
): ExtractedEventData {
  // Use page title as event name if not extracted
  if (!data.name && metadata.title) {
    data.name = metadata.title;
  }

  // Use og:image as event image if not extracted
  if (!data.imageUrl && metadata.ogImage) {
    data.imageUrl = metadata.ogImage;
  }

  // Extract from JSON-LD if available
  if (metadata.jsonLd) {
    const ld = metadata.jsonLd;

    if (!data.name && ld.name) {
      data.name = String(ld.name);
    }

    if (!data.description && ld.description) {
      data.description = sanitizeString(String(ld.description), 500);
    }

    if (!data.startDate && ld.startDate) {
      data.startDate = sanitizeDate(String(ld.startDate));
    }

    if (!data.endDate && ld.endDate) {
      data.endDate = sanitizeDate(String(ld.endDate));
    }

    // Location from JSON-LD
    const location = ld.location as Record<string, unknown> | undefined;
    if (location) {
      if (!data.venueName && location.name) {
        data.venueName = String(location.name);
      }

      const address = location.address as Record<string, unknown> | string | undefined;
      if (address) {
        if (typeof address === "string") {
          if (!data.venueAddress) data.venueAddress = address;
        } else {
          if (!data.venueAddress && address.streetAddress) {
            data.venueAddress = String(address.streetAddress);
          }
          if (!data.venueCity && address.addressLocality) {
            data.venueCity = String(address.addressLocality);
          }
          if (!data.venueState && address.addressRegion) {
            data.venueState = sanitizeState(String(address.addressRegion));
          }
        }
      }
    }

    // Image from JSON-LD
    if (!data.imageUrl && ld.image) {
      const image = ld.image;
      if (typeof image === "string") {
        data.imageUrl = sanitizeUrl(image);
      } else if (Array.isArray(image) && image[0]) {
        data.imageUrl = sanitizeUrl(typeof image[0] === "string" ? image[0] : (image[0] as Record<string, unknown>).url as string);
      } else if ((image as Record<string, unknown>).url) {
        data.imageUrl = sanitizeUrl(String((image as Record<string, unknown>).url));
      }
    }

    // Ticket URL from JSON-LD offers
    if (!data.ticketUrl && ld.offers) {
      const offers = ld.offers as Record<string, unknown> | Record<string, unknown>[];
      const offer = Array.isArray(offers) ? offers[0] : offers;
      if (offer?.url) {
        data.ticketUrl = sanitizeUrl(String(offer.url));
      }

      // Price from offers
      if (data.ticketPriceMin === null && offer?.price) {
        const price = sanitizePrice(offer.price);
        if (price !== null) {
          data.ticketPriceMin = price;
          data.ticketPriceMax = price;
        }
      }
      if (data.ticketPriceMin === null && offer?.lowPrice) {
        data.ticketPriceMin = sanitizePrice(offer.lowPrice);
      }
      if (data.ticketPriceMax === null && offer?.highPrice) {
        data.ticketPriceMax = sanitizePrice(offer.highPrice);
      }
    }
  }

  return data;
}

/**
 * Calculate confidence levels for extracted fields
 */
function calculateConfidence(
  data: ExtractedEventData,
  metadata: PageMetadata
): FieldConfidence {
  const confidence: FieldConfidence = {};

  // Higher confidence if data matches JSON-LD
  const hasJsonLd = !!metadata.jsonLd;

  for (const [key, value] of Object.entries(data)) {
    if (value === null) {
      confidence[key] = "low";
    } else if (hasJsonLd && metadata.jsonLd?.[key]) {
      confidence[key] = "high";
    } else if (key === "name" && metadata.title) {
      confidence[key] = "medium";
    } else if (key === "imageUrl" && metadata.ogImage) {
      confidence[key] = "medium";
    } else {
      confidence[key] = "medium";
    }
  }

  return confidence;
}

/**
 * Sanitize helpers
 */
function sanitizeString(value: unknown, maxLength?: number): string | null {
  if (value === null || value === undefined) return null;
  let str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;
  if (maxLength && str.length > maxLength) {
    str = str.substring(0, maxLength - 3) + "...";
  }
  return str;
}

function sanitizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null" || str.toLowerCase() === "tbd") return null;

  // Try to parse and format the date
  try {
    // If it's already in ISO format, validate and return
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(str)) {
      const date = new Date(str);
      if (!isNaN(date.getTime())) {
        // Return in YYYY-MM-DDTHH:MM:SS format if time present, otherwise YYYY-MM-DD
        if (str.includes("T")) {
          return date.toISOString().substring(0, 19);
        }
        return str.substring(0, 10);
      }
    }

    // Handle MM/DD/YYYY or M/D/YYYY format
    const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slashMatch) {
      const month = slashMatch[1].padStart(2, "0");
      const day = slashMatch[2].padStart(2, "0");
      let year = slashMatch[3];
      if (year.length === 2) {
        year = parseInt(year) > 50 ? `19${year}` : `20${year}`;
      }
      return `${year}-${month}-${day}`;
    }

    // Handle "Month Day, Year" format (e.g., "January 15, 2025")
    const monthNames: Record<string, string> = {
      january: "01", jan: "01",
      february: "02", feb: "02",
      march: "03", mar: "03",
      april: "04", apr: "04",
      may: "05",
      june: "06", jun: "06",
      july: "07", jul: "07",
      august: "08", aug: "08",
      september: "09", sep: "09", sept: "09",
      october: "10", oct: "10",
      november: "11", nov: "11",
      december: "12", dec: "12",
    };

    const monthDayYear = str.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})$/i);
    if (monthDayYear) {
      const monthNum = monthNames[monthDayYear[1].toLowerCase()];
      if (monthNum) {
        const day = monthDayYear[2].padStart(2, "0");
        return `${monthDayYear[3]}-${monthNum}-${day}`;
      }
    }

    // Handle "Day Month Year" format (e.g., "15 January 2025")
    const dayMonthYear = str.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+),?\s*(\d{4})$/i);
    if (dayMonthYear) {
      const monthNum = monthNames[dayMonthYear[2].toLowerCase()];
      if (monthNum) {
        const day = dayMonthYear[1].padStart(2, "0");
        return `${dayMonthYear[3]}-${monthNum}-${day}`;
      }
    }

    // Try native Date parsing as fallback
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      // Check if the year is reasonable (between 2020 and 2100)
      const year = date.getFullYear();
      if (year >= 2020 && year <= 2100) {
        return date.toISOString().substring(0, 10);
      }
    }
  } catch {
    // Parsing failed
  }

  return null;
}

function sanitizeState(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toUpperCase();
  if (str === "" || str.toLowerCase() === "null") return null;

  // If already 2-letter code, return it
  if (/^[A-Z]{2}$/.test(str)) {
    return str;
  }

  // Common state name to abbreviation mapping
  const stateMap: Record<string, string> = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    "NEW HAMPSHIRE": "NH",
    "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM",
    "NEW YORK": "NY",
    "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    "WEST VIRGINIA": "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
  };

  return stateMap[str] || str.substring(0, 2);
}

function sanitizeUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;

  try {
    const url = new URL(str);
    return url.href;
  } catch {
    // Not a valid absolute URL
    return null;
  }
}

function sanitizePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return value >= 0 ? value : null;
  }

  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;

  // Extract numeric value (handles "$10", "10.00", "$10.99 USD", etc.)
  const match = str.match(/[\d.]+/);
  if (match) {
    const num = parseFloat(match[0]);
    return !isNaN(num) && num >= 0 ? num : null;
  }

  return null;
}
