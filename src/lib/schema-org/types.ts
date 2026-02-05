/**
 * Normalized schema.org Event data extracted from JSON-LD
 */
export interface SchemaOrgEventData {
  name: string | null;
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  venueName: string | null;
  venueAddress: string | null;
  venueCity: string | null;
  venueState: string | null;
  venueLat: number | null;
  venueLng: number | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  priceMin: number | null;
  priceMax: number | null;
  eventStatus: string | null;
  organizerName: string | null;
  organizerUrl: string | null;
}

/**
 * Status of schema.org fetch operation
 */
export type SchemaOrgStatus = "pending" | "available" | "not_found" | "invalid" | "error";

/**
 * Result from parsing JSON-LD
 */
export interface ParseResult {
  success: boolean;
  data: SchemaOrgEventData | null;
  rawJsonLd: string | null;
  status: SchemaOrgStatus;
  error?: string;
}

/**
 * Result from fetching and parsing a URL
 */
export interface FetchSchemaOrgResult {
  success: boolean;
  data: SchemaOrgEventData | null;
  rawJsonLd: string | null;
  status: SchemaOrgStatus;
  error?: string;
}

/**
 * Fields that can be compared between event and schema.org data
 */
export interface SchemaOrgComparisonField {
  key: string;
  label: string;
  currentValue: string | number | Date | null;
  schemaValue: string | number | Date | null;
  isDifferent: boolean;
}

/**
 * Raw JSON-LD Event schema (partial, for typing purposes)
 */
export interface JsonLdEvent {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: JsonLdLocation | JsonLdLocation[];
  image?: string | string[] | { url?: string }[];
  offers?: JsonLdOffer | JsonLdOffer[];
  eventStatus?: string;
  organizer?: JsonLdOrganizer | JsonLdOrganizer[];
  performer?: unknown;
  [key: string]: unknown;
}

export interface JsonLdLocation {
  "@type"?: string;
  name?: string;
  address?: string | JsonLdPostalAddress;
  geo?: JsonLdGeoCoordinates;
  url?: string;
  [key: string]: unknown;
}

export interface JsonLdPostalAddress {
  "@type"?: string;
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
  [key: string]: unknown;
}

export interface JsonLdGeoCoordinates {
  "@type"?: string;
  latitude?: number | string;
  longitude?: number | string;
  [key: string]: unknown;
}

export interface JsonLdOffer {
  "@type"?: string;
  url?: string;
  price?: number | string;
  lowPrice?: number | string;
  highPrice?: number | string;
  priceCurrency?: string;
  availability?: string;
  validFrom?: string;
  [key: string]: unknown;
}

export interface JsonLdOrganizer {
  "@type"?: string;
  name?: string;
  url?: string;
  [key: string]: unknown;
}
