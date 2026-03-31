/**
 * Application-wide constants
 */

// Pagination
export const PAGINATION = {
  EVENTS_PER_PAGE: 12,
  ADMIN_LIST_LIMIT: 50,
  RECENT_ITEMS_LIMIT: 5,
  MAX_PAGE_SIZE: 100,
} as const;

// Event statuses
export const EVENT_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  TENTATIVE: "TENTATIVE",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;

// Statuses visible on public pages
export const PUBLIC_EVENT_STATUSES = [
  EVENT_STATUS.APPROVED,
  EVENT_STATUS.TENTATIVE,
] as const;

// Venue statuses
export const VENUE_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;

// User roles
export const USER_ROLE = {
  ADMIN: "ADMIN",
  PROMOTER: "PROMOTER",
  VENDOR: "VENDOR",
  USER: "USER",
} as const;

// Event vendor statuses (application lifecycle)
export const EVENT_VENDOR_STATUS = {
  INVITED: "INVITED",
  INTERESTED: "INTERESTED",
  APPLIED: "APPLIED",
  WAITLISTED: "WAITLISTED",
  APPROVED: "APPROVED",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
  CANCELLED: "CANCELLED",
} as const;

// Statuses visible on public pages
export const PUBLIC_VENDOR_STATUSES = [
  EVENT_VENDOR_STATUS.APPROVED,
  EVENT_VENDOR_STATUS.CONFIRMED,
] as const;

// Payment statuses (orthogonal to application status)
export const PAYMENT_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  PAID: "PAID",
  REFUNDED: "REFUNDED",
  OVERDUE: "OVERDUE",
} as const;

// Favoritable types
export const FAVORITABLE_TYPE = {
  EVENT: "EVENT",
  VENUE: "VENUE",
  VENDOR: "VENDOR",
  PROMOTER: "PROMOTER",
} as const;

// Validation limits
export const VALIDATION = {
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 255,
  DESCRIPTION_MAX_LENGTH: 5000,
  SLUG_MAX_LENGTH: 255,
  URL_MAX_LENGTH: 2048,
  EMAIL_MAX_LENGTH: 255,
  PHONE_MAX_LENGTH: 50,
  ADDRESS_MAX_LENGTH: 500,
  ZIP_MAX_LENGTH: 20,
  STATE_MAX_LENGTH: 50,
  CITY_MAX_LENGTH: 100,
} as const;

// Similarity thresholds for duplicate detection
export const DUPLICATE_DETECTION = {
  DEFAULT_THRESHOLD: 0.7,
  MIN_THRESHOLD: 0.5,
  MAX_THRESHOLD: 1.0,
} as const;

// Type exports for type safety
export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];
export type VenueStatus = (typeof VENUE_STATUS)[keyof typeof VENUE_STATUS];
export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];
export type EventVendorStatus = (typeof EVENT_VENDOR_STATUS)[keyof typeof EVENT_VENDOR_STATUS];
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];
export type FavoritableType = (typeof FAVORITABLE_TYPE)[keyof typeof FAVORITABLE_TYPE];
