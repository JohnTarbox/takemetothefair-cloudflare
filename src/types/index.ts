export type {
  User,
  Venue,
  Promoter,
  Event,
  Vendor,
  EventVendor,
  EventDay,
  UserFavorite,
  Notification,
} from "@/lib/db/schema";

export type UserRole = "ADMIN" | "PROMOTER" | "VENDOR" | "USER";
export type EventStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type VenueStatus = "ACTIVE" | "INACTIVE";
export type ApplicationStatus = "PENDING" | "APPROVED" | "REJECTED";

import type { User, Venue, Promoter, Event, Vendor, EventVendor, EventDay } from "@/lib/db/schema";

export type EventWithRelations = Event & {
  promoter: Promoter & { user: Pick<User, "name" | "email"> };
  venue: Venue;
  eventVendors?: (EventVendor & { vendor: Vendor })[];
};

export type VendorWithRelations = Vendor & {
  user: Pick<User, "name" | "email">;
  eventVendors?: (EventVendor & { event: Event })[];
};

export type PromoterWithRelations = Promoter & {
  user: Pick<User, "name" | "email">;
  events?: Event[];
};

export interface SearchParams {
  query?: string;
  category?: string;
  startDate?: string;
  endDate?: string;
  city?: string;
  state?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Helper to parse JSON arrays stored as strings
export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
