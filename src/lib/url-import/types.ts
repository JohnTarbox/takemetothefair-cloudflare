export interface ExtractedEventData {
  name: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  startTime: string | null; // "HH:MM" 24-hour format
  endTime: string | null; // "HH:MM" 24-hour format
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
