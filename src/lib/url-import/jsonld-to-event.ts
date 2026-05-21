/**
 * Map a schema.org Event JSON-LD node onto our ExtractedEventData shape.
 *
 * When a fetched page emits valid Event-schema JSON-LD (typically from a
 * WordPress events plugin — The Events Calendar, EventOn, Events Manager —
 * or a venue's CMS), this mapper produces a fully-typed event without
 * going through the Workers AI extraction step. JSON-LD is the
 * authoritative source on those pages; the AI just paraphrases the same
 * content from prose, often with worse fidelity (wrong dates, hallucinated
 * venues, etc).
 *
 * Failure mode: returns null. The caller falls through to the AI extractor.
 * We accept JSON-LD only when:
 *   1. name + startDate are both present (the absolute minimum for a
 *      submittable event).
 *   2. At least one of {location, description} is also present — having
 *      only name+date is too thin for a useful submission, and these are
 *      the fields AI extraction is most likely to do better on.
 *
 * Per analyst spec: do NOT default ticket_url to source_url. Leave null
 * when offers.url is missing — the AI extractor's behavior too.
 */

import type { ExtractedEventData } from "./types";

/**
 * Try to produce an ExtractedEventData from a parsed JSON-LD Event node.
 * Returns null when the node doesn't pass the minimum-fields gate (caller
 * should fall through to AI extraction).
 */
export function tryExtractFromJsonLd(jsonLd: Record<string, unknown>): ExtractedEventData | null {
  const name = coerceString(jsonLd.name);
  const startDate = normalizeDate(jsonLd.startDate);
  if (!name || !startDate) return null;

  const endDate = normalizeDate(jsonLd.endDate);
  const description = coerceString(jsonLd.description);
  const location = parseLocation(jsonLd.location);
  const image = parseImage(jsonLd.image);
  const offers = parseOffers(jsonLd.offers);

  // Minimum-fields gate (analyst spec): need at least 3 of
  // {name, dates, location, description}. name + startDate already cover 2;
  // require one more from location or description.
  const hasLocation = !!(location.venueName || location.venueAddress);
  if (!hasLocation && !description) return null;

  const { startTime, endTime } = parseTimes(jsonLd.startDate, jsonLd.endDate);

  return {
    name,
    description,
    startDate,
    endDate,
    startTime,
    endTime,
    hoursVaryByDay: false,
    hoursNotes: null,
    specificDates: null,
    venueName: location.venueName,
    venueAddress: location.venueAddress,
    venueCity: location.venueCity,
    venueState: location.venueState,
    isStatewide: false,
    stateCode: location.venueState, // state_code matches venue state when known
    ticketUrl: offers.url,
    ticketPriceMin: offers.priceMin,
    ticketPriceMax: null, // JSON-LD offers.price is a single value, not a range
    imageUrl: image,
    categories: null, // Schema.org has no direct event-category vocabulary; let AI infer if needed
    vendorFeeMin: null,
    vendorFeeMax: null,
    vendorFeeNotes: null,
    indoorOutdoor: null,
    estimatedAttendance: null,
    applicationUrl: null,
    walkInsAllowed: null,
  };
}

/**
 * Coerce a string-or-non-string field to either a clean string or null.
 * Trims, drops empties. Rejects non-string types because schema.org
 * Producers sometimes nest a TextObject — those have a .text property
 * but most consumers ignore them; defer to AI rather than guess.
 */
function coerceString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a schema.org Date / DateTime to YYYY-MM-DD. JSON-LD's
 * startDate is officially ISO-8601 (either "2026-12-15" or
 * "2026-12-15T19:00:00-05:00") but in the wild we also see plain
 * "December 15, 2026", US slash-format dates, and other variants. Use
 * Date parsing as a fallback, then strip to YYYY-MM-DD.
 *
 * NOT a full date normalizer — the submit endpoint's downstream
 * date-handling code applies the noon-UTC + epoch-seconds conversion.
 * We only need to produce YYYY-MM-DD here to match the ExtractedEventData
 * contract.
 */
function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;

  // Already YYYY-MM-DD (with optional time suffix)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // Last-resort: let Date parse, then re-emit. We force UTC to avoid
  // off-by-one-day drift when the local TZ is east of UTC and the input
  // is a "midnight UTC" date string.
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = parsed.getUTCFullYear();
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Pull HH:MM time strings out of a startDate/endDate ISO datetime, if
 * one is present. Returns nulls when the input is date-only.
 */
function parseTimes(
  rawStart: unknown,
  rawEnd: unknown
): { startTime: string | null; endTime: string | null } {
  return {
    startTime: extractTime(rawStart),
    endTime: extractTime(rawEnd),
  };
}

function extractTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // Match "...THH:MM" with optional seconds + timezone.
  const m = v.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

interface LocationFields {
  venueName: string | null;
  venueAddress: string | null;
  venueCity: string | null;
  venueState: string | null;
}

/**
 * Parse a schema.org `location` field. Two shapes in the wild:
 *   - string: "Town Hall" — name only, no structured address
 *   - Place object: { name, address: PostalAddress | string }
 *   - VirtualLocation: skip (online-only events don't fit our model)
 *
 * When `address` is a PostalAddress, pull streetAddress / addressLocality
 * / addressRegion. When it's a plain string, store as venueAddress and
 * leave city/state null — the venue resolver in PR-C (A2 fuzzy match)
 * will use whatever it can.
 */
function parseLocation(v: unknown): LocationFields {
  const empty: LocationFields = {
    venueName: null,
    venueAddress: null,
    venueCity: null,
    venueState: null,
  };
  if (!v) return empty;

  if (typeof v === "string") {
    return { ...empty, venueName: v.trim() || null };
  }
  if (typeof v !== "object") return empty;

  const place = v as Record<string, unknown>;
  const venueName = coerceString(place.name);

  const addr = place.address;
  if (typeof addr === "string") {
    return { ...empty, venueName, venueAddress: addr.trim() || null };
  }
  if (addr && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    return {
      venueName,
      venueAddress: coerceString(a.streetAddress),
      venueCity: coerceString(a.addressLocality),
      venueState: normalizeStateCode(a.addressRegion),
    };
  }

  return { ...empty, venueName };
}

/**
 * Coerce addressRegion to a 2-letter state code when it's already one,
 * or null otherwise. Schema.org allows full names ("Massachusetts") or
 * codes ("MA"); we only persist 2-letter codes in events.state_code.
 * Full-name → code mapping is intentionally NOT done here — leave that
 * to a deliberate lookup elsewhere if needed.
 */
function normalizeStateCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

/**
 * Pull a single image URL from schema.org `image`. May be a string, an
 * array of strings, an ImageObject ({url, contentUrl}), or an array of
 * those. Return the first usable URL.
 */
function parseImage(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const url = parseImage(item);
      if (url) return url;
    }
    return null;
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return coerceString(obj.url) || coerceString(obj.contentUrl);
  }
  return null;
}

interface OfferFields {
  url: string | null;
  priceMin: number | null;
}

/**
 * Parse schema.org `offers`. Single Offer or array. We only extract
 * price (as a number — schema.org allows string "10.00" or numeric 10)
 * and url. priceCurrency is dropped — we treat all prices as USD until
 * we have multi-currency support.
 */
function parseOffers(v: unknown): OfferFields {
  const empty: OfferFields = { url: null, priceMin: null };
  if (!v) return empty;

  const first = Array.isArray(v) ? v[0] : v;
  if (!first || typeof first !== "object") return empty;

  const o = first as Record<string, unknown>;
  return {
    url: coerceString(o.url),
    priceMin: coerceNumber(o.price),
  };
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
