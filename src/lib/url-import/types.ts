/**
 * Date/time storage convention (P3c, 2026-06-06)
 * -----------------------------------------------
 * - `startDate` / `endDate` / `applicationDeadline`: ISO 8601 calendar dates
 *   in "YYYY-MM-DD" form (no time component). These flow into date-only D1
 *   columns anchored at midnight UTC. Producers should NOT attach a time-of-
 *   day, even if the source page mentions one — the storage convention is
 *   date-only and downstream renders use `timeZone: "UTC"`.
 *
 * - `startTime` / `endTime`: "HH:MM" 24-hour wall-clock strings, interpreted
 *   as "the clock on the wall at the venue when the event opens / closes."
 *   No timezone is encoded in these strings; the venue's `timezone` column
 *   (drizzle/0112, P3a) supplies the IANA zone at conversion time via
 *   `parseWallClockInVenueZone(date, time, venue.timezone)`.
 *
 * - The conversion from "HH:MM" wall-clock + venue.timezone → UTC instant
 *   is intentionally DEFERRED until the venue is resolved. If a scraper or
 *   AI extractor produces wall-clock times before the venue is known,
 *   store them as-stated and convert at form submission / event_days
 *   construction time. Producers MUST NOT assume Eastern time (or any
 *   specific zone) at extraction; the conversion is the venue's job.
 *
 * - `specificDates`: each is a "YYYY-MM-DD" string, same date-only
 *   convention.
 */
export interface ExtractedEventData {
  name: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  startTime: string | null; // "HH:MM" 24-hour, wall-clock at venue (see header)
  endTime: string | null; // "HH:MM" 24-hour, wall-clock at venue (see header)
  hoursVaryByDay: boolean; // AI detected varying hours
  hoursNotes: string | null; // Free text (e.g., "Fri 5-9pm, Sat-Sun 10am-6pm")
  specificDates: string[] | null; // ["YYYY-MM-DD", ...] for non-contiguous dates
  venueName: string | null;
  venueAddress: string | null;
  venueCity: string | null;
  venueState: string | null;
  // Statewide / multi-location events with no single venue (e.g., Maine Pottery
  // Tour, Maine Open Lighthouse Day). When true, venue fields are ignored and
  // the event is placed on the state page via stateCode.
  isStatewide: boolean;
  stateCode: string | null; // Two-letter code, e.g. "ME"
  ticketUrl: string | null;
  ticketPriceMin: number | null;
  ticketPriceMax: number | null;
  imageUrl: string | null;
  // Event taxonomy
  categories: string[] | null; // From EVENT_CATEGORIES constant
  // Vendor decision-support fields
  vendorFeeMin: number | null;
  vendorFeeMax: number | null;
  vendorFeeNotes: string | null;
  indoorOutdoor: "INDOOR" | "OUTDOOR" | "MIXED" | null;
  estimatedAttendance: number | null;
  applicationUrl: string | null;
  // OPE-198 — vendor-application capture. `applicationDeadline` is a
  // "YYYY-MM-DD" date-only string (see the header convention); leave null
  // rather than guess. `applicationInstructions` is short prose (≤500 chars)
  // for when there's a stated apply process but no URL (e.g. "email the
  // organizer at X"). Both feed the OPE-191 vendor digest.
  // Optional (unlike the older vendor fields) so the many "blank event"
  // constructors in the wizard / suggest forms don't each need them; the AI
  // extractor always sets them explicitly via sanitizeEventData.
  applicationDeadline?: string | null;
  applicationInstructions?: string | null;
  walkInsAllowed: boolean | null;
}

// Extended event data with unique ID for tracking in multi-event selection
export interface ExtractedEvent extends ExtractedEventData {
  _extractId: string; // Unique ID for UI tracking (not saved to DB)
  _selected?: boolean; // Whether user selected this event for import
}

export interface FieldConfidence {
  [field: string]: "high" | "medium" | "low";
}

export interface EventConfidence {
  [eventId: string]: FieldConfidence;
}

export type VenueOption =
  | { type: "existing"; id: string }
  | { type: "new"; name: string; address: string; city: string; state: string }
  | { type: "none" };

export interface FetchResult {
  success: boolean;
  content?: string;
  title?: string;
  ogImage?: string;
  jsonLd?: Record<string, unknown>;
  error?: string;
}

// Single event extraction result (legacy support)
export interface ExtractResult {
  success: boolean;
  extracted?: ExtractedEventData;
  confidence?: FieldConfidence;
  error?: string;
}

// Multi-event extraction result
export interface MultiExtractResult {
  success: boolean;
  events: ExtractedEvent[];
  confidence: EventConfidence;
  error?: string;
}

export interface PageMetadata {
  title?: string;
  description?: string;
  ogImage?: string;
  // Legacy single-event JSON-LD slot — first Event-schema node found on the
  // page. Kept for backward compatibility with callers that haven't been
  // upgraded to the multi-event API below.
  jsonLd?: Record<string, unknown>;
  // Multi-event JSON-LD slot (analyst 2026-05-22 P7a): EVERY Event-schema
  // node found on the page, in document order. Populated alongside
  // `jsonLd` for back-compat. When a landing page describes N events via
  // JSON-LD (e.g., a venue calendar emitting one Event per row), the
  // extract endpoint maps each one to an ExtractedEvent instead of
  // dropping all but the first.
  jsonLdEvents?: Record<string, unknown>[];
}
