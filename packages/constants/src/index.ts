/**
 * Shared status enums + types used by both the main app and the MCP server.
 *
 * Schema-relevant constants live here (the values appear in Drizzle column
 * definitions and Zod enum validators); UI-only constants like pagination
 * limits stay in src/lib/constants.ts in the main app.
 */

// ── Site identity ─────────────────────────────────────────────────
// Single source of truth for the canonical site URL, hostname, and the
// support/from email address. Use SITE_URL when constructing absolute
// links, SITE_HOSTNAME for cases like iCal UIDs that need a bare host,
// SUPPORT_EMAIL for the noreply From address, and SCRAPER_USER_AGENT
// for outbound HTTP requests so polite-bot identification stays
// consistent across every scraper.

export const SITE_URL = "https://meetmeatthefair.com";
export const SITE_HOSTNAME = "meetmeatthefair.com";
export const SUPPORT_EMAIL = "noreply@meetmeatthefair.com";
export const SCRAPER_USER_AGENT =
  "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)";

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

/** Statuses visible on public pages.
 *
 *  Legacy gate — kept for backward compat. New code should use
 *  `publicEventWhere()` from `src/lib/event-lifecycle.ts` which combines
 *  this editorial gate with the lifecycle gate. The plan was to drop
 *  TENTATIVE here once it migrated to the lifecycle column, but we leave
 *  it in to keep the legacy check identical to current production
 *  behavior — anything visible BEFORE the lifecycle migration must stay
 *  visible AFTER, even on read paths that haven't been upgraded yet. */
export const PUBLIC_EVENT_STATUSES = [EVENT_STATUS.APPROVED, EVENT_STATUS.TENTATIVE] as const;

// ── Event lifecycle (real-world status, orthogonal to editorial) ──

export const EVENT_LIFECYCLE = {
  SCHEDULED: "SCHEDULED",
  TENTATIVE: "TENTATIVE",
  POSTPONED: "POSTPONED",
  RESCHEDULED: "RESCHEDULED",
  CANCELLED: "CANCELLED",
  OCCURRED: "OCCURRED",
  MOVED_ONLINE: "MOVED_ONLINE",
  NO_SHOW: "NO_SHOW",
} as const;
export type EventLifecycle = (typeof EVENT_LIFECYCLE)[keyof typeof EVENT_LIFECYCLE];
export const EVENT_LIFECYCLE_VALUES = Object.values(EVENT_LIFECYCLE) as readonly EventLifecycle[];

/** Lifecycle states that allow public visibility — combined with the
 *  editorial APPROVED check via `publicEventWhere()` in
 *  src/lib/event-lifecycle.ts. CANCELLED and NO_SHOW are deliberately
 *  excluded; OCCURRED stays public as evergreen SEO content. */
export const PUBLIC_LIFECYCLE_STATUSES = [
  EVENT_LIFECYCLE.SCHEDULED,
  EVENT_LIFECYCLE.TENTATIVE,
  EVENT_LIFECYCLE.POSTPONED,
  EVENT_LIFECYCLE.RESCHEDULED,
  EVENT_LIFECYCLE.OCCURRED,
  EVENT_LIFECYCLE.MOVED_ONLINE,
] as const;

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

// ── Event vendor participation mode (drizzle/0071) ────────────────
// Orthogonal to EVENT_VENDOR_STATUS. EXHIBITOR = takes booth space;
// SPONSOR_ONLY = logo/program presence, no booth; SPONSOR_AND_EXHIBITOR
// = both (e.g. venue naming rights + a booth on the floor).

export const PARTICIPATION_TYPE = {
  EXHIBITOR: "EXHIBITOR",
  SPONSOR_ONLY: "SPONSOR_ONLY",
  SPONSOR_AND_EXHIBITOR: "SPONSOR_AND_EXHIBITOR",
} as const;
export type ParticipationType = (typeof PARTICIPATION_TYPE)[keyof typeof PARTICIPATION_TYPE];
export const PARTICIPATION_TYPE_VALUES = Object.values(
  PARTICIPATION_TYPE
) as readonly ParticipationType[];

/** True when the vendor takes booth space (visible in the Exhibitors
 *  section + emitted in schema.org `performer`). */
export function isExhibitor(p: ParticipationType): boolean {
  return p === PARTICIPATION_TYPE.EXHIBITOR || p === PARTICIPATION_TYPE.SPONSOR_AND_EXHIBITOR;
}

/** True when the vendor is a sponsor (visible in the Sponsors section +
 *  emitted in schema.org `sponsor`). */
export function isSponsor(p: ParticipationType): boolean {
  return p === PARTICIPATION_TYPE.SPONSOR_ONLY || p === PARTICIPATION_TYPE.SPONSOR_AND_EXHIBITOR;
}

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
  // TAX1 A10 (2026-06-02). Two first-class values for the
  // charity / community gap. Kept distinct rather than collapsed
  // (e.g. "Community Event" + charity-as-tag) so category-browse
  // pages and the picker UI can surface them separately —
  // charitable events have different vendor / attendee semantics
  // than general community gatherings.
  "Charity",
  "Community Event",
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

// ── TAX1 Phase 1 — audience / access enums ────────────────────────
//
// Orthogonal to EVENT_CATEGORIES (what an event IS) and to vendor-
// access flags (who can SELL). Defaults are the permissive value so
// the 2026-06-02 migration is invisible: every pre-migration row
// reads as PUBLIC + OPEN, preserving today's semantics. See
// drizzle/0100_events_audience_access.sql + events.primaryAudience
// in packages/db-schema/src/index.ts.

export const PRIMARY_AUDIENCE = ["PUBLIC", "TRADE", "MEMBERS"] as const;
export type PrimaryAudience = (typeof PRIMARY_AUDIENCE)[number];

export const PUBLIC_ACCESS = ["OPEN", "CLOSED"] as const;
export type PublicAccess = (typeof PUBLIC_ACCESS)[number];

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
