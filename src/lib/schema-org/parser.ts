import type {
  SchemaOrgEventData,
  ParseResult,
  JsonLdEvent,
  JsonLdLocation,
  JsonLdPostalAddress,
  JsonLdOffer,
  JsonLdOrganizer,
} from "./types";

/**
 * Parse raw JSON-LD into normalized SchemaOrgEventData
 * Reuses logic patterns from ai-extractor.ts fallbackFromMetadata
 */
export function parseJsonLd(jsonLd: unknown): ParseResult {
  if (!jsonLd || typeof jsonLd !== "object") {
    return {
      success: false,
      data: null,
      rawJsonLd: null,
      status: "not_found",
      error: "No JSON-LD data provided",
    };
  }

  const ld = jsonLd as JsonLdEvent;

  // Verify it's an Event type
  const type = ld["@type"];
  const isEvent =
    type === "Event" ||
    (Array.isArray(type) && type.includes("Event")) ||
    (typeof type === "string" && type.toLowerCase().includes("event"));

  if (!isEvent) {
    return {
      success: false,
      data: null,
      rawJsonLd: JSON.stringify(jsonLd, null, 2),
      status: "invalid",
      error: "JSON-LD is not an Event type",
    };
  }

  const data: SchemaOrgEventData = {
    name: null,
    description: null,
    startDate: null,
    endDate: null,
    venueName: null,
    venueAddress: null,
    venueCity: null,
    venueState: null,
    venueLat: null,
    venueLng: null,
    imageUrl: null,
    ticketUrl: null,
    priceMin: null,
    priceMax: null,
    eventStatus: null,
    organizerName: null,
    organizerUrl: null,
  };

  // Extract basic fields
  if (ld.name) {
    data.name = sanitizeString(ld.name);
  }

  if (ld.description) {
    data.description = sanitizeString(ld.description, 2000);
  }

  // Parse dates
  if (ld.startDate) {
    data.startDate = parseDate(ld.startDate);
  }
  if (ld.endDate) {
    data.endDate = parseDate(ld.endDate);
  }

  // Parse location
  const location = Array.isArray(ld.location) ? ld.location[0] : ld.location;
  if (location) {
    parseLocation(location, data);
  }

  // Parse image
  if (ld.image) {
    data.imageUrl = parseImage(ld.image);
  }

  // Parse offers
  const offers = Array.isArray(ld.offers) ? ld.offers : ld.offers ? [ld.offers] : [];
  if (offers.length > 0) {
    parseOffers(offers, data);
  }

  // Parse event status
  if (ld.eventStatus) {
    data.eventStatus = sanitizeString(ld.eventStatus);
  }

  // Parse organizer
  const organizer = Array.isArray(ld.organizer) ? ld.organizer[0] : ld.organizer;
  if (organizer) {
    parseOrganizer(organizer, data);
  }

  return {
    success: true,
    data,
    rawJsonLd: JSON.stringify(jsonLd, null, 2),
    status: "available",
  };
}

/**
 * Parse location from JSON-LD into venue fields
 */
function parseLocation(location: JsonLdLocation, data: SchemaOrgEventData): void {
  // Handle VirtualLocation
  if (location["@type"] === "VirtualLocation") {
    data.venueName = "Online Event";
    if (location.url) {
      data.venueAddress = sanitizeString(location.url);
    }
    return;
  }

  // Place or other physical location
  if (location.name) {
    data.venueName = sanitizeString(location.name);
  }

  // Parse address
  const address = location.address;
  if (address) {
    if (typeof address === "string") {
      data.venueAddress = sanitizeString(address);
      // Try to parse city/state from string address
      const parts = address.split(",").map((p) => p.trim());
      if (parts.length >= 2) {
        data.venueCity = parts[parts.length - 2] || null;
        // Last part might be "State ZIP" or just state
        const lastPart = parts[parts.length - 1];
        const stateMatch = lastPart?.match(/^([A-Za-z\s]+)/);
        if (stateMatch) {
          data.venueState = sanitizeState(stateMatch[1]);
        }
      }
    } else {
      const postal = address as JsonLdPostalAddress;
      if (postal.streetAddress) {
        data.venueAddress = sanitizeString(postal.streetAddress);
      }
      if (postal.addressLocality) {
        data.venueCity = sanitizeString(postal.addressLocality);
      }
      if (postal.addressRegion) {
        data.venueState = sanitizeState(postal.addressRegion);
      }
    }
  }

  // Parse geo coordinates
  if (location.geo) {
    const lat = parseFloat(String(location.geo.latitude));
    const lng = parseFloat(String(location.geo.longitude));
    if (!isNaN(lat) && !isNaN(lng)) {
      data.venueLat = lat;
      data.venueLng = lng;
    }
  }
}

/**
 * Parse image from various JSON-LD formats
 */
function parseImage(image: string | string[] | { url?: string }[]): string | null {
  if (typeof image === "string") {
    return sanitizeUrl(image);
  }

  if (Array.isArray(image) && image.length > 0) {
    const first = image[0];
    if (typeof first === "string") {
      return sanitizeUrl(first);
    }
    if (first && typeof first === "object" && "url" in first) {
      return sanitizeUrl(first.url);
    }
  }

  return null;
}

/**
 * Parse offers to extract ticket URL and prices
 */
function parseOffers(offers: JsonLdOffer[], data: SchemaOrgEventData): void {
  let minPrice: number | null = null;
  let maxPrice: number | null = null;

  for (const offer of offers) {
    // Get ticket URL from first offer with URL
    if (!data.ticketUrl && offer.url) {
      data.ticketUrl = sanitizeUrl(offer.url);
    }

    // Handle AggregateOffer
    if (offer["@type"] === "AggregateOffer") {
      if (offer.lowPrice !== undefined) {
        const low = parsePrice(offer.lowPrice);
        if (low !== null && (minPrice === null || low < minPrice)) {
          minPrice = low;
        }
      }
      if (offer.highPrice !== undefined) {
        const high = parsePrice(offer.highPrice);
        if (high !== null && (maxPrice === null || high > maxPrice)) {
          maxPrice = high;
        }
      }
    }

    // Regular Offer price
    if (offer.price !== undefined) {
      const price = parsePrice(offer.price);
      if (price !== null) {
        if (minPrice === null || price < minPrice) {
          minPrice = price;
        }
        if (maxPrice === null || price > maxPrice) {
          maxPrice = price;
        }
      }
    }
  }

  data.priceMin = minPrice;
  data.priceMax = maxPrice;
}

/**
 * Parse organizer information
 */
function parseOrganizer(organizer: JsonLdOrganizer, data: SchemaOrgEventData): void {
  if (organizer.name) {
    data.organizerName = sanitizeString(organizer.name);
  }
  if (organizer.url) {
    data.organizerUrl = sanitizeUrl(organizer.url);
  }
}

// Utility functions

function sanitizeString(value: unknown, maxLength?: number): string | null {
  if (value === null || value === undefined) return null;
  let str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;
  if (maxLength && str.length > maxLength) {
    str = str.substring(0, maxLength - 3) + "...";
  }
  return str;
}

function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null" || str.toLowerCase() === "tbd") return null;

  try {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      return date;
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
    ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR",
    CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE",
    FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID",
    ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS",
    KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
    MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS",
    MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
    "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
    "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
    OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
    VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
    WISCONSIN: "WI", WYOMING: "WY",
  };

  return stateMap[str] || (str.length >= 2 ? str.substring(0, 2) : null);
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

function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return value >= 0 ? value : null;
  }

  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null" || str.toLowerCase() === "free") {
    return str.toLowerCase() === "free" ? 0 : null;
  }

  // Extract numeric value (handles "$10", "10.00", "$10.99 USD", etc.)
  const match = str.match(/[\d.]+/);
  if (match) {
    const num = parseFloat(match[0]);
    return !isNaN(num) && num >= 0 ? num : null;
  }

  return null;
}
