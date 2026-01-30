// Shared types for all scrapers

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
