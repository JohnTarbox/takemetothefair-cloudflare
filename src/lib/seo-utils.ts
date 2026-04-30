import { formatDateRange } from "@/lib/utils";
import { parseJsonArray } from "@/types";

const META_DESCRIPTION_MAX = 160;
const META_DESCRIPTION_MIN_USEFUL = 50;

/**
 * Truncate to maxLength while respecting word boundaries when the break would
 * not lose more than 40% of the budget.
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
  categories?: string | null;
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

  const desc = event.description?.trim() || "";
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL && base.length < 120) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      base += ". " + truncateAtWord(desc, remaining);
    }
  }

  // Structured fallback when the venue/date base is sparse and the DB
  // description didn't fill it out — pull a category hint so each event still
  // gets a unique meta description rather than identical boilerplate.
  if (base.length < META_DESCRIPTION_MIN_USEFUL + event.name.length) {
    const categories = parseJsonArray(event.categories);
    const primaryCategory = categories[0];
    if (primaryCategory) {
      const stateSuffix = event.venue?.state ? ` in ${event.venue.state}` : "";
      base += `. ${primaryCategory}${stateSuffix}.`;
    }
  }

  if (base.length < 120) {
    base += " Find details, directions, and vendor information.";
  }

  return truncateAtWord(base, META_DESCRIPTION_MAX);
}

export function buildVenueMetaDescription(venue: {
  name: string;
  description?: string | null;
  city?: string | null;
  state?: string | null;
  amenities?: string | null;
  capacity?: number | null;
}): string {
  const location = venue.city && venue.state ? ` in ${venue.city}, ${venue.state}` : "";
  const base = `${venue.name}${location}`;

  const desc = venue.description?.trim() || "";
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      return truncateAtWord(`${base}. ${truncateAtWord(desc, remaining)}`, META_DESCRIPTION_MAX);
    }
  }

  // Structured fallback: prefer top amenities, otherwise generic event hint.
  const amenities = parseJsonArray(venue.amenities);
  if (amenities.length > 0) {
    const featured = amenities.slice(0, 3).join(", ");
    return truncateAtWord(
      `${base}. Featuring ${featured}. Browse upcoming fairs, festivals, and events.`,
      META_DESCRIPTION_MAX
    );
  }

  return truncateAtWord(
    `${base}. Hosting fairs, festivals, and events. View upcoming dates and vendor lineups.`,
    META_DESCRIPTION_MAX
  );
}

export function buildVendorMetaDescription(vendor: {
  businessName: string;
  description?: string | null;
  vendorType?: string | null;
  products?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const base = vendor.vendorType
    ? `${vendor.businessName} — ${vendor.vendorType}`
    : vendor.businessName;

  const desc = vendor.description?.trim() || "";
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      return truncateAtWord(`${base}. ${truncateAtWord(desc, remaining)}`, META_DESCRIPTION_MAX);
    }
  }

  // Structured fallback: top products + location so each vendor's meta
  // description differs from the next, even with no DB description.
  const products = parseJsonArray(vendor.products);
  const productPhrase = products.length > 0 ? `. ${products.slice(0, 3).join(", ")}` : "";
  const locationPhrase =
    vendor.city && vendor.state ? `, based in ${vendor.city}, ${vendor.state}` : "";

  if (productPhrase || locationPhrase) {
    return truncateAtWord(
      `${base}${productPhrase}${locationPhrase}. Find upcoming events on Meet Me at the Fair.`,
      META_DESCRIPTION_MAX
    );
  }

  return truncateAtWord(
    `${base}. Find upcoming events and learn more on Meet Me at the Fair.`,
    META_DESCRIPTION_MAX
  );
}
