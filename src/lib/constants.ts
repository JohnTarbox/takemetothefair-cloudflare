/**
 * Application-wide constants.
 *
 * Schema-relevant enums (statuses, roles, categories) live in
 * `packages/constants/` so the main app and MCP server share one source
 * of truth. App-only constants (pagination limits, listing-route slugs,
 * validation limits) stay here.
 */

// Re-exports from the canonical workspace package. Existing imports of the
// shared enums from "@/lib/constants" continue to work.
export {
  EVENT_STATUS,
  EVENT_STATUS_VALUES,
  PUBLIC_EVENT_STATUSES,
  VENUE_STATUS,
  USER_ROLE,
  EVENT_VENDOR_STATUS,
  EVENT_VENDOR_STATUS_VALUES,
  PUBLIC_VENDOR_STATUSES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  BLOG_POST_STATUS,
  FAVORITABLE_TYPE,
  INDOOR_OUTDOOR,
  EVENT_SCALE,
  EVENT_CATEGORIES,
  VENDOR_STATUS_TRANSITIONS,
  type EventStatus,
  type VenueStatus,
  type UserRole,
  type EventVendorStatus,
  type PaymentStatus,
  type BlogPostStatus,
  type FavoritableType,
  type IndoorOutdoor,
  type EventScale,
  type EventCategory,
} from "@takemetothefair/constants";

// ── App-only constants ─────────────────────────────────────────────

// Pagination
export const PAGINATION = {
  EVENTS_PER_PAGE: 24,
  ADMIN_LIST_LIMIT: 50,
  RECENT_ITEMS_LIMIT: 5,
  MAX_PAGE_SIZE: 100,
} as const;

/**
 * Event URL slugs that are actually listing routes (category or state pages),
 * not individual event slugs. The content-link parser skips these when
 * indexing /events/{slug} references from blog bodies — otherwise a post that
 * says "see all /events/fairs" would create a broken link index row.
 *
 * Keep this aligned with the directory listing under `src/app/events/`.
 */
export const EVENT_LISTING_SLUGS = new Set<string>([
  "all",
  "past",
  "fairs",
  "festivals",
  "craft-fairs",
  "craft-shows",
  "markets",
  "farmers-markets",
  "maine",
  "vermont",
  "new-hampshire",
  "massachusetts",
  "connecticut",
  "rhode-island",
]);

// Validation limits live in @takemetothefair/validation (schema-layer concern).
// Re-exported here so any legacy `import { VALIDATION } from "@/lib/constants"`
// keeps working until those imports migrate.
export { VALIDATION } from "@takemetothefair/validation";

// Similarity thresholds for duplicate detection
export const DUPLICATE_DETECTION = {
  DEFAULT_THRESHOLD: 0.7,
  MIN_THRESHOLD: 0.5,
  MAX_THRESHOLD: 1.0,
} as const;
