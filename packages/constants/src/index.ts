/**
 * Shared status enums + types used by both the main app and the MCP server.
 *
 * Schema-relevant constants live here (the values appear in Drizzle column
 * definitions and Zod enum validators); UI-only constants like pagination
 * limits stay in src/lib/constants.ts in the main app.
 */

// ── Event statuses ────────────────────────────────────────────────

export const EVENT_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  TENTATIVE: "TENTATIVE",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

/** Tuple form for Zod enums and other Array-like consumers. */
export const EVENT_STATUS_VALUES = Object.values(EVENT_STATUS) as readonly EventStatus[];

/** Statuses visible on public pages. */
export const PUBLIC_EVENT_STATUSES = [EVENT_STATUS.APPROVED, EVENT_STATUS.TENTATIVE] as const;

// ── Venue statuses ────────────────────────────────────────────────

export const VENUE_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;
export type VenueStatus = (typeof VENUE_STATUS)[keyof typeof VENUE_STATUS];

// ── User roles ────────────────────────────────────────────────────

export const USER_ROLE = {
  ADMIN: "ADMIN",
  PROMOTER: "PROMOTER",
  VENDOR: "VENDOR",
  USER: "USER",
} as const;
export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];

// ── Event-vendor application statuses (lifecycle) ─────────────────

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
export type EventVendorStatus = (typeof EVENT_VENDOR_STATUS)[keyof typeof EVENT_VENDOR_STATUS];

/** Tuple form for Zod enums. */
export const EVENT_VENDOR_STATUS_VALUES = Object.values(
  EVENT_VENDOR_STATUS
) as readonly EventVendorStatus[];

/** Statuses visible to the public (vendor list on event pages). */
export const PUBLIC_VENDOR_STATUSES = [
  EVENT_VENDOR_STATUS.APPROVED,
  EVENT_VENDOR_STATUS.CONFIRMED,
] as const;

// ── Payment statuses (orthogonal to application status) ───────────

export const PAYMENT_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  PAID: "PAID",
  REFUNDED: "REFUNDED",
  OVERDUE: "OVERDUE",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];
export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS) as readonly PaymentStatus[];

// ── Blog post statuses ────────────────────────────────────────────

export const BLOG_POST_STATUS = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
} as const;
export type BlogPostStatus = (typeof BLOG_POST_STATUS)[keyof typeof BLOG_POST_STATUS];

// ── Favoritable polymorphic types ─────────────────────────────────

export const FAVORITABLE_TYPE = {
  EVENT: "EVENT",
  VENUE: "VENUE",
  VENDOR: "VENDOR",
  PROMOTER: "PROMOTER",
} as const;
export type FavoritableType = (typeof FAVORITABLE_TYPE)[keyof typeof FAVORITABLE_TYPE];

// ── Indoor/outdoor designation ────────────────────────────────────

export const INDOOR_OUTDOOR = {
  INDOOR: "INDOOR",
  OUTDOOR: "OUTDOOR",
  MIXED: "MIXED",
} as const;
export type IndoorOutdoor = (typeof INDOOR_OUTDOOR)[keyof typeof INDOOR_OUTDOOR];

// ── Event scale (rough size categories) ───────────────────────────

export const EVENT_SCALE = {
  SMALL: "SMALL",
  MEDIUM: "MEDIUM",
  LARGE: "LARGE",
  MAJOR: "MAJOR",
} as const;
export type EventScale = (typeof EVENT_SCALE)[keyof typeof EVENT_SCALE];

// ── Event categories (advisory taxonomy for dropdowns/filters) ────

export const EVENT_CATEGORIES = [
  "Agricultural Fair",
  "Antique Show",
  "Art Walk",
  "Car Show",
  "Craft Fair",
  "Craft Show",
  "Farmers Market",
  "Festival",
  "Fiber Arts Festival",
  "Flea Market",
  "Food Festival",
  "Holiday Market",
  "Home Show",
  "Music Festival",
  "Trade Show",
  "Other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

// ── Event-vendor status transition state machine ──────────────────
// Used by both the admin event-vendor PATCH endpoint (main app) and the
// MCP update_event_vendor tool. Single source of truth so the rules don't
// drift between the two write paths.

export const VENDOR_STATUS_TRANSITIONS: Record<EventVendorStatus, EventVendorStatus[]> = {
  INVITED: ["INTERESTED", "APPLIED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  INTERESTED: ["APPLIED", "WITHDRAWN", "CANCELLED"],
  APPLIED: ["WAITLISTED", "APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN"],
  WAITLISTED: ["APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  APPROVED: ["CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  CONFIRMED: ["WITHDRAWN", "CANCELLED"],
  REJECTED: ["APPLIED", "INVITED"],
  WITHDRAWN: ["APPLIED", "INTERESTED"],
  CANCELLED: ["INVITED"],
};
