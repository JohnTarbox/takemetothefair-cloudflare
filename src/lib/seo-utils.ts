import { formatDateRange } from "@/lib/utils";

/**
 * Build a meta description that's 120-160 characters, truncating at word boundaries.
 */
function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxLength * 0.6 ? truncated.slice(0, lastSpace) : truncated;
}

export function buildEventMetaDescription(event: {
  name: string;
  description?: string | null;
  venue?: { name: string; city?: string | null; state?: string | null } | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}): string {
  const parts: string[] = [event.name];

  if (event.venue) {
    parts.push(`at ${event.venue.name}`);
    if (event.venue.city && event.venue.state) {
      parts.push(`in ${event.venue.city}, ${event.venue.state}`);
    }
  }

  const dateStr = formatDateRange(event.startDate, event.endDate);
  if (dateStr !== "TBD") {
    parts.push(`on ${dateStr}`);
  }

  let base = parts.join(" ");

  if (event.description && base.length < 120) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      base += ". " + truncateAtWord(event.description, remaining);
    }
  }

  if (base.length < 120) {
    base += ". Find details, directions, and vendor information.";
  }

  return truncateAtWord(base, 160);
}

export function buildVenueMetaDescription(venue: {
  name: string;
  description?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const location = venue.city && venue.state ? ` in ${venue.city}, ${venue.state}` : "";
  const base = `${venue.name}${location}`;

  if (venue.description) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      return truncateAtWord(`${base}. ${truncateAtWord(venue.description, remaining)}`, 160);
    }
  }

  return truncateAtWord(`${base}. View upcoming fairs, festivals, and events at this venue on Meet Me at the Fair.`, 160);
}

export function buildVendorMetaDescription(vendor: {
  businessName: string;
  description?: string | null;
  vendorType?: string | null;
}): string {
  const base = vendor.vendorType
    ? `${vendor.businessName} - ${vendor.vendorType}`
    : vendor.businessName;

  if (vendor.description) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      return truncateAtWord(`${base}. ${truncateAtWord(vendor.description, remaining)}`, 160);
    }
  }

  return truncateAtWord(`${base}. Find upcoming events and learn more on Meet Me at the Fair.`, 160);
}
