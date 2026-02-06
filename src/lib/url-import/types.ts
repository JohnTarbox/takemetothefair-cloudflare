export interface ExtractedEventData {
  name: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  venueName: string | null;
  venueAddress: string | null;
  venueCity: string | null;
  venueState: string | null;
  ticketUrl: string | null;
  ticketPriceMin: number | null;
  ticketPriceMax: number | null;
  imageUrl: string | null;
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
  jsonLd?: Record<string, unknown>;
}
