// Shared types for all scrapers.
//
// Date/time storage convention (mirrors src/lib/url-import/types.ts):
//   - startDate/endDate are Date instances anchored at midnight UTC
//     (date-only convention; #358/P3c). No time-of-day baked into these.
//   - eventDays carries any per-day open/close hours found on the source
//     page. "HH:MM" 24-hour wall-clock-at-venue strings, NO timezone
//     embedded. The wall-clock → UTC conversion is deferred until ICS
//     export at render time (uses venue.timezone via P3b's
//     parseWallClockInVenueZone). Producers MUST NOT assume Eastern
//     time at extraction.

export interface ScrapedVenue {
  name: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface ScrapedEvent {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  name: string;
  startDate?: Date;
  endDate?: Date;
  datesConfirmed?: boolean;
  description?: string;
  location?: string;
  city?: string;
  state?: string;
  address?: string;
  imageUrl?: string;
  ticketUrl?: string;
  website?: string;
  venue?: ScrapedVenue;
  commercialVendorsAllowed?: boolean;
  vendorTypes?: string[]; // e.g., ["Art", "Craft", "Food", "Commercial"]
  /** Per-day open/close hours when the source page provides them.
   *  Stored as "HH:MM" 24-hour wall-clock-at-venue strings per the
   *  url-import convention. Empty/absent when the source has no time-
   *  of-day data — the promoter/admin can add per-day rows manually. */
  eventDays?: Array<{
    date: string; // "YYYY-MM-DD"
    openTime: string; // "HH:MM" 24-hour
    closeTime: string; // "HH:MM" 24-hour
    notes?: string;
  }>;
}

export interface ScrapeResult {
  success: boolean;
  events: ScrapedEvent[];
  error?: string;
}

export interface ScraperEntry {
  scrape: (options?: { stateCode?: string; customUrl?: string }) => Promise<ScrapeResult>;
  scrapeDetails: (url: string) => Promise<Partial<ScrapedEvent>>;
}
