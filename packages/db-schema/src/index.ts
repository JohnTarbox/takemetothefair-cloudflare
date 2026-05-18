import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { relations, sql } from "drizzle-orm";
import type { Slug } from "@takemetothefair/utils";

// Users table
export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  name: text("name"),
  role: text("role", { enum: ["ADMIN", "PROMOTER", "VENDOR", "USER"] })
    .default("USER")
    .notNull(),
  emailVerified: integer("email_verified", { mode: "timestamp" }),
  image: text("image"),
  oauthProvider: text("oauth_provider"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Venues table
export const venues = sqliteTable(
  "venues",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").$type<Slug>().notNull().unique(),
    address: text("address").notNull(),
    city: text("city").notNull(),
    state: text("state").notNull(),
    zip: text("zip").notNull(),
    latitude: real("latitude"),
    longitude: real("longitude"),
    capacity: integer("capacity"),
    amenities: text("amenities").default("[]"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    website: text("website"),
    description: text("description"),
    imageUrl: text("image_url"),
    googlePlaceId: text("google_place_id"),
    googleMapsUrl: text("google_maps_url"),
    openingHours: text("opening_hours"),
    googleRating: real("google_rating"),
    googleRatingCount: integer("google_rating_count"),
    googleTypes: text("google_types"),
    accessibility: text("accessibility"),
    parking: text("parking"),
    status: text("status", { enum: ["ACTIVE", "INACTIVE"] })
      .default("ACTIVE")
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [index("idx_venues_status").on(table.status)]
);

// Promoters table
export const promoters = sqliteTable("promoters", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .unique()
    .references(() => users.id, { onDelete: "set null" }),
  companyName: text("company_name").notNull(),
  slug: text("slug").$type<Slug>().notNull().unique(),
  description: text("description"),
  website: text("website"),
  socialLinks: text("social_links"),
  logoUrl: text("logo_url"),
  city: text("city"),
  state: text("state"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  verified: integer("verified", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Events table
export const events = sqliteTable(
  "events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").$type<Slug>().notNull().unique(),
    description: text("description"),
    promoterId: text("promoter_id")
      .notNull()
      .references(() => promoters.id, { onDelete: "cascade" }),
    venueId: text("venue_id").references(() => venues.id, { onDelete: "set null" }),
    // Denormalized from venue.state; required when venueId is null (enforced in validation).
    stateCode: text("state_code"),
    // True for events with no single physical venue (statewide tours, multi-location trails).
    isStatewide: integer("is_statewide", { mode: "boolean" }).notNull().default(false),
    startDate: integer("start_date", { mode: "timestamp" }),
    endDate: integer("end_date", { mode: "timestamp" }),
    publicStartDate: integer("public_start_date", { mode: "timestamp" }),
    publicEndDate: integer("public_end_date", { mode: "timestamp" }),
    datesConfirmed: integer("dates_confirmed", { mode: "boolean" }).default(true),
    recurrenceRule: text("recurrence_rule"),
    categories: text("categories").default("[]"),
    tags: text("tags").default("[]"),
    ticketUrl: text("ticket_url"),
    // UNIT: integer cents. Migrated from REAL dollars in 0044. Display
    // converts to dollars via formatPrice() in src/lib/format.ts (divides
    // by 100 at the formatter boundary). Never reintroduce float dollars
    // anywhere — accumulating arithmetic loses precision and breaks any
    // future payment-processing integration.
    ticketPriceMinCents: integer("ticket_price_min_cents"),
    ticketPriceMaxCents: integer("ticket_price_max_cents"),
    imageUrl: text("image_url"),
    featured: integer("featured", { mode: "boolean" }).default(false),
    commercialVendorsAllowed: integer("commercial_vendors_allowed", { mode: "boolean" }).default(
      true
    ),
    status: text("status", {
      enum: ["DRAFT", "PENDING", "TENTATIVE", "APPROVED", "REJECTED", "CANCELLED"],
    })
      .default("DRAFT")
      .notNull(),
    viewCount: integer("view_count").default(0),
    // External source tracking for synced events
    sourceName: text("source_name"), // e.g., "mainefairs.net"
    sourceUrl: text("source_url"), // URL of the event on the source site
    sourceId: text("source_id"), // Unique identifier from the source (e.g., slug or ID)
    syncEnabled: integer("sync_enabled", { mode: "boolean" }).default(true),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    // Discontinuous dates: when true, eventDays hold arbitrary (non-contiguous) dates
    discontinuousDates: integer("discontinuous_dates", { mode: "boolean" }).default(false),
    // Vendor decision-support fields. Same integer-cents convention as
    // ticketPriceMin/MaxCents above.
    vendorFeeMinCents: integer("vendor_fee_min_cents"),
    vendorFeeMaxCents: integer("vendor_fee_max_cents"),
    vendorFeeNotes: text("vendor_fee_notes"),
    indoorOutdoor: text("indoor_outdoor"), // INDOOR, OUTDOOR, MIXED
    estimatedAttendance: integer("estimated_attendance"),
    eventScale: text("event_scale"), // SMALL, MEDIUM, LARGE, MAJOR
    applicationDeadline: integer("application_deadline", { mode: "timestamp" }),
    applicationUrl: text("application_url"),
    applicationInstructions: text("application_instructions"),
    walkInsAllowed: integer("walk_ins_allowed", { mode: "boolean" }),
    // Suggester email for community-suggested events
    suggesterEmail: text("suggester_email"),
    // Tracks who submitted the event (vendor, community user, etc.)
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // §10.2 cached 0-100 completeness score (drizzle/0055). Same gate as vendors:
    // entries with completenessScore < 40 are excluded from /sitemap.xml.
    completenessScore: integer("completeness_score").notNull().default(0),
    // Lifecycle status — orthogonal to editorial `status`. Maps 1:1 to schema.org
    // Event status URIs for SCHEDULED/POSTPONED/RESCHEDULED/CANCELLED/MOVED_ONLINE;
    // OCCURRED, NO_SHOW, TENTATIVE are MMATF additions for past-event semantics +
    // dates-not-yet-confirmed. Source of truth lives in src/lib/event-lifecycle.ts.
    lifecycleStatus: text("lifecycle_status", {
      enum: [
        "SCHEDULED",
        "TENTATIVE",
        "POSTPONED",
        "RESCHEDULED",
        "CANCELLED",
        "OCCURRED",
        "MOVED_ONLINE",
        "NO_SHOW",
      ],
    })
      .notNull()
      .default("SCHEDULED"),
    lifecycleStatusChangedAt: integer("lifecycle_status_changed_at", { mode: "timestamp" }),
    lifecycleReason: text("lifecycle_reason"),
    // For RESCHEDULED events — the dates the event was previously scheduled
    // for. Schema.org's EventRescheduled rich snippet needs the immediately-
    // previous pair to render in Google. Single pair only; multi-reschedule
    // history would need a separate event_date_history table.
    previousStartDate: integer("previous_start_date", { mode: "timestamp" }),
    previousEndDate: integer("previous_end_date", { mode: "timestamp" }),
    // Pre-ingest gate trace. JSON array of short reason codes when
    // evaluateGates() routed the row to PENDING_REVIEW. NULL = gate did
    // not fire OR row predates the gates. See src/lib/event-date-gates.ts.
    gateFlags: text("gate_flags"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_events_status_startdate").on(table.status, table.startDate),
    index("idx_events_venueid").on(table.venueId),
    index("idx_events_promoterid").on(table.promoterId),
    index("idx_events_state_code").on(table.stateCode),
    index("idx_events_completeness_score").on(table.completenessScore),
    index("idx_events_lifecycle_status").on(table.lifecycleStatus),
  ]
);

// Periodic re-verification cron findings (drizzle/0070). Stores drift
// between events.start_date and canonical_start_date fetched from
// events.source_url. Drives the event_date_drift recommendation card.
// Sweep details: src/app/api/admin/event-date-drift/sweep/route.ts.
export const eventDateDriftFindings = sqliteTable(
  "event_date_drift_findings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    storedStartDate: integer("stored_start_date", { mode: "timestamp" }).notNull(),
    canonicalStartDate: integer("canonical_start_date", { mode: "timestamp" }),
    driftDays: integer("drift_days").notNull(),
    canonicalUrl: text("canonical_url"),
    canonicalHtmlExcerpt: text("canonical_html_excerpt"),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (t) => [
    index("idx_event_date_drift_findings_event_id").on(t.eventId),
    index("idx_event_date_drift_findings_resolved_at").on(t.resolvedAt),
    // Mirrors the migration's UNIQUE constraint so Drizzle's inferred
    // type knows the upsert key.
    uniqueIndex("uq_event_date_drift_findings_event_id_stored_start").on(
      t.eventId,
      t.storedStartDate
    ),
  ]
);

// Vendors table
export const vendors = sqliteTable("vendors", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull(),
  slug: text("slug").$type<Slug>().notNull().unique(),
  description: text("description"),
  vendorType: text("vendor_type"),
  products: text("products").default("[]"),
  website: text("website"),
  socialLinks: text("social_links"),
  logoUrl: text("logo_url"),
  verified: integer("verified", { mode: "boolean" }).default(false),
  commercial: integer("commercial", { mode: "boolean" }).default(false),
  canSelfConfirm: integer("can_self_confirm", { mode: "boolean" }).default(false),
  // Contact Information
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  // Physical Address
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  // Geolocation (auto-populated from Google Places)
  latitude: real("latitude"),
  longitude: real("longitude"),
  // Business Details
  yearEstablished: integer("year_established"),
  paymentMethods: text("payment_methods").default("[]"), // JSON array
  licenseInfo: text("license_info"),
  insuranceInfo: text("insurance_info"),
  // Enhanced Profile (paid tier, round-3 — drizzle/0037)
  enhancedProfile: integer("enhanced_profile", { mode: "boolean" }).notNull().default(false),
  enhancedProfileStartedAt: integer("enhanced_profile_started_at", { mode: "timestamp" }),
  enhancedProfileExpiresAt: integer("enhanced_profile_expires_at", { mode: "timestamp" }),
  galleryImages: text("gallery_images").notNull().default("[]"), // JSON array of {url, alt, caption?}
  featuredPriority: integer("featured_priority").notNull().default(0),
  // Claimed tier (drizzle/0049) — vendor-confirmed ownership, distinct from userId
  // which every vendor has. Drives the Claimed badge and tier-transition rules.
  claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
  claimedAt: integer("claimed_at", { mode: "timestamp" }),
  claimedBy: text("claimed_by").references(() => users.id, { onDelete: "set null" }),
  // Per-vendor view count (drizzle/0051). Server-incremented on each cached
  // page render; ISR cache provides implicit ~5-min dedup. Used by the
  // claimed_ready_for_enhanced_upsell rule for top-decile-by-views ranking.
  viewCount: integer("view_count").notNull().default(0),
  // Verified Pro tier scaffold (drizzle/0052). Credentialed identity-verification
  // signal, orthogonal to the four-tier model. Admin-only set today; the actual
  // identity-verification UX (LLC lookup, address validation, etc.) is a separate
  // Q1-2027 product feature that just flips this flag when ready.
  verifiedPro: integer("verified_pro", { mode: "boolean" }).notNull().default(false),
  verifiedProAt: integer("verified_pro_at", { mode: "timestamp" }),
  verifiedProBy: text("verified_pro_by").references(() => users.id, { onDelete: "set null" }),
  // Soft delete (drizzle/0053). Non-null = vendor invisible everywhere; URL
  // returns 410 Gone or 301 to redirectToVendorId if set. Hard purge happens
  // after a 30-day grace window via the sweep-purge-deleted endpoint.
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
  redirectToVendorId: text("redirect_to_vendor_id").references((): AnySQLiteColumn => vendors.id, {
    onDelete: "set null",
  }),
  // §10.2 enrichment + quality tracking (drizzle/0054). enrichmentSource is one
  // of: ai_workers | scraper | manual_admin | vendor_self | mcp_create. The
  // enum lives in src/lib/enrichment-log.ts (TS-only, not DB-enforced because
  // adding a new source shouldn't require a migration). completenessScore is
  // a cached 0-100 value; recomputed via computeVendorCompleteness on every
  // insert/update and gates inclusion in /sitemap.xml at >= 40.
  enrichmentSource: text("enrichment_source"),
  enrichmentAttemptedAt: integer("enrichment_attempted_at", { mode: "timestamp" }),
  domainHijacked: integer("domain_hijacked", { mode: "boolean" }).notNull().default(false),
  completenessScore: integer("completeness_score").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Vendor self-serve claim verification tokens (drizzle/0050).
// SHA-256 hash of the raw token is stored; raw token only exists in
// the verification email URL parameter.
export const vendorClaimTokens = sqliteTable(
  "vendor_claim_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    vendorIdx: index("idx_vendor_claim_tokens_vendor").on(t.vendorId),
    expiresIdx: index("idx_vendor_claim_tokens_expires").on(t.expiresAt),
  })
);

// Vendor slug history — for 301-redirecting old URLs after a slug change.
// drizzle/0038
export const vendorSlugHistory = sqliteTable(
  "vendor_slug_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    oldSlug: text("old_slug").$type<Slug>().notNull(),
    newSlug: text("new_slug").$type<Slug>().notNull(),
    changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
    changedBy: text("changed_by"),
  },
  (t) => ({
    oldSlugIdx: index("idx_vendor_slug_history_old_slug").on(t.oldSlug),
    vendorIdIdx: index("idx_vendor_slug_history_vendor_id").on(t.vendorId),
  })
);

// Event slug history — mirrors vendorSlugHistory for /events/[slug].
// drizzle/0061
export const eventSlugHistory = sqliteTable(
  "event_slug_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    oldSlug: text("old_slug").$type<Slug>().notNull(),
    newSlug: text("new_slug").$type<Slug>().notNull(),
    changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
    changedBy: text("changed_by"),
  },
  (t) => ({
    oldSlugIdx: index("idx_event_slug_history_old_slug").on(t.oldSlug),
    eventIdIdx: index("idx_event_slug_history_event_id").on(t.eventId),
  })
);

// Admin actions audit log — drizzle/0039.
// Generic enough for non-vendor actions later; first user is the Enhanced
// Profile lifecycle (activate / expire_set / auto_expire).
export const adminActions = sqliteTable(
  "admin_actions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    action: text("action").notNull(), // "enhanced_profile.activate", etc.
    actorUserId: text("actor_user_id"), // null for cron-driven
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    payloadJson: text("payload_json"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    targetIdx: index("idx_admin_actions_target").on(t.targetType, t.targetId),
    createdAtIdx: index("idx_admin_actions_created_at").on(t.createdAt),
  })
);

// Event Vendors junction table
export const eventVendors = sqliteTable(
  "event_vendors",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    boothInfo: text("booth_info"),
    status: text("status", {
      enum: [
        "INVITED",
        "INTERESTED",
        "APPLIED",
        "WAITLISTED",
        "APPROVED",
        "CONFIRMED",
        "REJECTED",
        "WITHDRAWN",
        "CANCELLED",
      ],
    })
      .default("APPLIED")
      .notNull(),
    paymentStatus: text("payment_status", {
      enum: ["NOT_REQUIRED", "PENDING", "PAID", "REFUNDED", "OVERDUE"],
    })
      .default("NOT_REQUIRED")
      .notNull(),
    // Participation mode (drizzle/0071, 2026-05-16). Orthogonal to `status`,
    // which captures commitment lifecycle. EXHIBITOR = takes booth space;
    // SPONSOR_ONLY = logo/program presence, no booth; SPONSOR_AND_EXHIBITOR
    // = both. Public event pages split this into Exhibitors + Sponsors
    // sections; JSON-LD emits SPONSOR_ONLY/SPONSOR_AND_EXHIBITOR in the
    // schema.org `sponsor` array, EXHIBITOR/SPONSOR_AND_EXHIBITOR in
    // `performer`.
    participationType: text("participation_type", {
      enum: ["EXHIBITOR", "SPONSOR_ONLY", "SPONSOR_AND_EXHIBITOR"],
    })
      .default("EXHIBITOR")
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_eventvendors_eventid_status").on(table.eventId, table.status),
    index("idx_eventvendors_vendorid").on(table.vendorId),
    // Closes the race in update_vendor_status / create_or_link_vendor where
    // SELECT-then-INSERT could yield duplicate (event,vendor) rows under
    // concurrent calls. Added 2026-05-10.
    uniqueIndex("idx_eventvendors_event_vendor_unique").on(table.eventId, table.vendorId),
  ]
);

// Event Data Citations table — provenance log for event field values that come
// from external sources (homepage hero, press release, vendor PDF, etc.). One
// row per citation, not per field; lifecycle (active / superseded / rejected /
// stale) resolves which row is the current authority. The denormalized
// columns on events (estimatedAttendance, vendorFeeMinCents, etc.) stay as
// the consumer-facing cache of the current `active` citation. See
// MMATF-Analysis/MMATF-Automation-Spec.md §4.3.1.
export const eventDataCitations = sqliteTable(
  "event_data_citations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    fieldName: text("field_name").notNull(),
    value: text("value").notNull(),
    year: integer("year"),
    sourceUrl: text("source_url").notNull(),
    sourceName: text("source_name"),
    sourceType: text("source_type", {
      enum: [
        "official_website",
        "news_article",
        "press_release",
        "social_media",
        "user_submitted",
        "other",
      ],
    }).notNull(),
    confidence: real("confidence"),
    state: text("state", {
      enum: ["active", "superseded", "rejected", "stale"],
    })
      .notNull()
      .default("active"),
    notes: text("notes"),
    supersedesCitationId: text("supersedes_citation_id").references(
      (): AnySQLiteColumn => eventDataCitations.id,
      { onDelete: "set null" }
    ),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_citations_event_field").on(table.eventId, table.fieldName),
    index("idx_citations_event_state").on(table.eventId, table.state),
    index("idx_citations_state").on(table.state),
  ]
);

// Event Days table - per-day schedules for multi-day events
export const eventDays = sqliteTable("event_days", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // "YYYY-MM-DD" format
  openTime: text("open_time").notNull(), // "HH:MM" 24-hour format
  closeTime: text("close_time").notNull(), // "HH:MM" 24-hour format
  notes: text("notes"),
  closed: integer("closed", { mode: "boolean" }).default(false),
  vendorOnly: integer("vendor_only", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// User Favorites table
export const userFavorites = sqliteTable(
  "user_favorites",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    favoritableType: text("favoritable_type", {
      enum: ["EVENT", "VENUE", "VENDOR", "PROMOTER"],
    }).notNull(),
    favoritableId: text("favoritable_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [index("idx_userfavorites_userid_type").on(table.userId, table.favoritableType)]
);

// Notifications table
export const notifications = sqliteTable("notifications", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: integer("read", { mode: "boolean" }).default(false),
  data: text("data"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// NextAuth tables
export const accounts = sqliteTable("accounts", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refreshToken: text("refresh_token"),
  accessToken: text("access_token"),
  expiresAt: integer("expires_at"),
  tokenType: text("token_type"),
  scope: text("scope"),
  idToken: text("id_token"),
  sessionState: text("session_state"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionToken: text("session_token").notNull().unique(),
  expires: integer("expires", { mode: "timestamp" }).notNull(),
});

export const verificationTokens = sqliteTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: integer("expires", { mode: "timestamp" }).notNull(),
});

export const newsletterSubscribers = sqliteTable(
  "newsletter_subscribers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull().unique(),
    source: text("source"),
    confirmed: integer("confirmed", { mode: "boolean" }).default(false).notNull(),
    unsubscribed: integer("unsubscribed", { mode: "boolean" }).default(false).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => ({
    emailIdx: index("idx_newsletter_email").on(table.email),
  })
);

/**
 * Content link index. Maintained by `syncContentLinks` whenever a blog post
 * body is written; never edited manually.
 *
 * source_type is currently only BLOG_POST but has room to grow (e.g. PAGE).
 * target_id is nullable: if the referenced slug doesn't resolve to an existing
 * event/vendor/venue row, the link is still recorded with target_slug so the
 * broken-link surface can show it.
 */
export const contentLinks = sqliteTable(
  "content_links",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sourceType: text("source_type", { enum: ["BLOG_POST"] }).notNull(),
    sourceId: text("source_id").notNull(),
    targetType: text("target_type", { enum: ["EVENT", "VENDOR", "VENUE"] }).notNull(),
    targetSlug: text("target_slug").notNull(),
    targetId: text("target_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    // Stamped after we successfully fire a promoter blog-mention email for
    // this row. NULL means we haven't notified yet (or this link type isn't
    // notifiable). See src/lib/content-links-sync.ts for the firing logic.
    notifiedAt: integer("notified_at", { mode: "timestamp" }),
  },
  (table) => ({
    uniqueIdx: index("idx_content_links_unique").on(
      table.sourceType,
      table.sourceId,
      table.targetType,
      table.targetSlug
    ),
    targetIdIdx: index("idx_content_links_target_id").on(table.targetType, table.targetId),
    targetSlugIdx: index("idx_content_links_target_slug").on(table.targetType, table.targetSlug),
    sourceIdx: index("idx_content_links_source").on(table.sourceType, table.sourceId),
  })
);

export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    token: text("token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: integer("expires", { mode: "timestamp" }).notNull(),
    // NOTE: migration 0028 set the SQL default to `unixepoch('now')` (seconds),
    // but mode: "timestamp" expects ms. Drizzle's $defaultFn wins on every
    // insert path Drizzle controls, so the SQL default is dormant. If anyone
    // ever inserts via raw `wrangler d1 execute`, they'll create 1970 dates.
    // Don't lean on the SQL default — always go through Drizzle.
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => ({
    userIdIdx: index("idx_password_reset_tokens_user_id").on(table.userId),
    expiresIdx: index("idx_password_reset_tokens_expires").on(table.expires),
  })
);

// Event Schema.org Data table - stores fetched schema.org markup from ticket URLs
export const eventSchemaOrg = sqliteTable("event_schema_org", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  eventId: text("event_id")
    .notNull()
    .unique()
    .references(() => events.id, { onDelete: "cascade" }),
  ticketUrl: text("ticket_url"),
  rawJsonLd: text("raw_json_ld"), // Raw JSON-LD blob for audit/debugging
  // Normalized schema.org fields
  schemaName: text("schema_name"),
  schemaDescription: text("schema_description"),
  schemaStartDate: integer("schema_start_date", { mode: "timestamp" }),
  schemaEndDate: integer("schema_end_date", { mode: "timestamp" }),
  schemaVenueName: text("schema_venue_name"),
  schemaVenueAddress: text("schema_venue_address"),
  schemaVenueCity: text("schema_venue_city"),
  schemaVenueState: text("schema_venue_state"),
  schemaVenueLat: real("schema_venue_lat"),
  schemaVenueLng: real("schema_venue_lng"),
  schemaImageUrl: text("schema_image_url"),
  schemaTicketUrl: text("schema_ticket_url"),
  // Integer cents (post-0048). Mirrors the events.ticket_price_*_cents +
  // vendor_fee_*_cents convention so SchemaOrgPanel can compare without
  // multiplying. Inputs converted at the API boundary via dollarsToCents().
  schemaPriceMinCents: integer("schema_price_min_cents"),
  schemaPriceMaxCents: integer("schema_price_max_cents"),
  schemaEventStatus: text("schema_event_status"), // EventScheduled, EventCancelled, etc.
  schemaOrganizerName: text("schema_organizer_name"),
  schemaOrganizerUrl: text("schema_organizer_url"),
  // Fetch status tracking
  status: text("status", { enum: ["pending", "available", "not_found", "invalid", "error"] })
    .default("pending")
    .notNull(),
  lastFetchedAt: integer("last_fetched_at", { mode: "timestamp" }),
  lastError: text("last_error"),
  fetchCount: integer("fetch_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// API Tokens table — for MCP server / external API authentication
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  name: text("name").notNull().default("Default"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Blog Posts table
export const blogPosts = sqliteTable(
  "blog_posts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    slug: text("slug").$type<Slug>().notNull().unique(),
    body: text("body").notNull(), // Markdown content
    excerpt: text("excerpt"),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tags: text("tags").default("[]"),
    categories: text("categories").default("[]"),
    faqs: text("faqs").notNull().default("[]"),
    featuredImageUrl: text("featured_image_url"),
    status: text("status", { enum: ["DRAFT", "PUBLISHED"] })
      .default("DRAFT")
      .notNull(),
    publishDate: integer("publish_date", { mode: "timestamp" }),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_blogposts_status_publishdate").on(table.status, table.publishDate),
    index("idx_blogposts_slug").on(table.slug),
    index("idx_blogposts_authorid").on(table.authorId),
  ]
);

// Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  promoter: one(promoters, { fields: [users.id], references: [promoters.userId] }),
  vendor: one(vendors, { fields: [users.id], references: [vendors.userId] }),
  favorites: many(userFavorites),
  notifications: many(notifications),
  accounts: many(accounts),
  sessions: many(sessions),
  apiTokens: many(apiTokens),
  blogPosts: many(blogPosts),
}));

export const venuesRelations = relations(venues, ({ many }) => ({
  events: many(events),
}));

export const promotersRelations = relations(promoters, ({ one, many }) => ({
  user: one(users, { fields: [promoters.userId], references: [users.id] }),
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  promoter: one(promoters, { fields: [events.promoterId], references: [promoters.id] }),
  venue: one(venues, { fields: [events.venueId], references: [venues.id] }),
  eventVendors: many(eventVendors),
  eventDays: many(eventDays),
  schemaOrg: one(eventSchemaOrg, { fields: [events.id], references: [eventSchemaOrg.eventId] }),
  dataCitations: many(eventDataCitations),
}));

export const eventSchemaOrgRelations = relations(eventSchemaOrg, ({ one }) => ({
  event: one(events, { fields: [eventSchemaOrg.eventId], references: [events.id] }),
}));

export const eventDaysRelations = relations(eventDays, ({ one }) => ({
  event: one(events, { fields: [eventDays.eventId], references: [events.id] }),
}));

export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  user: one(users, { fields: [vendors.userId], references: [users.id] }),
  eventVendors: many(eventVendors),
}));

export const eventVendorsRelations = relations(eventVendors, ({ one }) => ({
  event: one(events, { fields: [eventVendors.eventId], references: [events.id] }),
  vendor: one(vendors, { fields: [eventVendors.vendorId], references: [vendors.id] }),
}));

export const eventDataCitationsRelations = relations(eventDataCitations, ({ one }) => ({
  event: one(events, { fields: [eventDataCitations.eventId], references: [events.id] }),
  createdByUser: one(users, {
    fields: [eventDataCitations.createdBy],
    references: [users.id],
  }),
  supersedes: one(eventDataCitations, {
    fields: [eventDataCitations.supersedesCitationId],
    references: [eventDataCitations.id],
    relationName: "citation_supersession",
  }),
}));

export const userFavoritesRelations = relations(userFavorites, ({ one }) => ({
  user: one(users, { fields: [userFavorites.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, { fields: [apiTokens.userId], references: [users.id] }),
}));

export const blogPostsRelations = relations(blogPosts, ({ one }) => ({
  author: one(users, { fields: [blogPosts.authorId], references: [users.id] }),
}));

// Analytics Events table — server-side event tracking.
// timestamp: seconds-epoch (Drizzle mode:"timestamp" stores Math.floor(date.getTime() / 1000)). Migrated from raw seconds
// in 0043 — single timestamp convention across the codebase.
export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventName: text("event_name").notNull(),
    eventCategory: text("event_category").notNull(),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
    properties: text("properties").default("{}"),
    userId: text("user_id"),
    source: text("source"),
  },
  (table) => [
    index("idx_analytics_events_name_ts").on(table.eventName, table.timestamp),
    index("idx_analytics_events_category_ts").on(table.eventCategory, table.timestamp),
  ]
);

// Site Health — see drizzle/0034_add_site_health.sql
// All *At columns: seconds-epoch (mode:"timestamp"). Migrated from raw seconds in 0043.
export const healthIssues = sqliteTable(
  "health_issues",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fingerprint: text("fingerprint").notNull().unique(),
    source: text("source").notNull(),
    issueType: text("issue_type").notNull(),
    severity: text("severity").notNull(),
    url: text("url"),
    message: text("message"),
    firstDetectedAt: integer("first_detected_at", { mode: "timestamp" }).notNull(),
    lastDetectedAt: integer("last_detected_at", { mode: "timestamp" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_health_issues_source").on(table.source, table.lastDetectedAt),
    index("idx_health_issues_open").on(table.resolvedAt),
  ]
);

export const healthIssueSnoozes = sqliteTable("health_issue_snoozes", {
  fingerprint: text("fingerprint").primaryKey(),
  snoozedUntil: integer("snoozed_until", { mode: "timestamp" }).notNull(),
  snoozedBy: text("snoozed_by").notNull(),
  snoozedAt: integer("snoozed_at", { mode: "timestamp" }).notNull(),
  note: text("note"),
});

export const gscInspectionState = sqliteTable(
  "gsc_inspection_state",
  {
    url: text("url").primaryKey(),
    lastInspectedAt: integer("last_inspected_at", { mode: "timestamp" }).notNull(),
    lastVerdict: text("last_verdict"),
    lastCoverageState: text("last_coverage_state"),
    source: text("source").notNull().default("sitemap"),
  },
  (table) => [index("idx_gsc_inspection_state_stale").on(table.lastInspectedAt)]
);

// IndexNow Submissions table — records every pingIndexNow() attempt for observability.
// timestamp: seconds-epoch (mode:"timestamp"). Migrated from raw seconds in 0043.
export const indexnowSubmissions = sqliteTable(
  "indexnow_submissions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
    source: text("source").notNull(),
    urls: text("urls").notNull().default("[]"),
    urlCount: integer("url_count").notNull().default(0),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    errorMessage: text("error_message"),
  },
  (table) => [index("idx_indexnow_submissions_timestamp").on(table.timestamp)]
);

// Pending Search Pings — outbox for deferred IndexNow + schema.org regen
// requests. Bulk ingestion workflows set `defer_search_ping: true` on each
// write, which routes the lifecycle hook into this table instead of firing
// immediately. `flush_pending_search_pings` (MCP admin tool) or the hourly
// cron drains the table, dedupes URLs, and submits one batched IndexNow call.
// Added 2026-05-10 alongside create_or_link_vendor (PR 2 of the perf work).
//
// Columns:
//   - entityType: 'vendor' | 'venue' | 'event' | 'promoter' | 'blog'
//   - entityId: PK of the entity (FK not enforced — entities can be deleted
//     before flush and we still want the row to drain harmlessly)
//   - entitySlug: denormalized so URL construction doesn't need a JOIN
//   - action: 'create' | 'update' | 'status_change' (informational only;
//     flushes just submit the URL regardless)
//   - queuedAt / flushedAt: seconds-epoch
//   - flushedBatchId: filled by flush invocations as both a claim marker
//     (concurrent flushes claim disjoint batches) and traceability link
export const pendingSearchPings = sqliteTable(
  "pending_search_pings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entitySlug: text("entity_slug").notNull(),
    action: text("action").notNull(),
    queuedAt: integer("queued_at", { mode: "timestamp" }).notNull(),
    flushedAt: integer("flushed_at", { mode: "timestamp" }),
    flushedBatchId: text("flushed_batch_id"),
  },
  (table) => [
    index("idx_pending_pings_unflushed").on(table.flushedAt, table.queuedAt),
    index("idx_pending_pings_batch").on(table.flushedBatchId),
  ]
);

// URL Domain Classifications — see drizzle/0036_add_url_domain_classifications.sql
// Gates which outbound URLs are legitimate as ticket / application destinations
// or as ingestion sources. Three independent flags handle context asymmetry
// (Eventbrite is a fine ticket dest but not a source; fairsandfestivals.net is
// the inverse). Fail-open: unknown domains pass through. See src/lib/url-classification.ts.
export const urlDomainClassifications = sqliteTable(
  "url_domain_classifications",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    domain: text("domain").notNull().unique(),
    domainType: text("domain_type").notNull(),
    useAsTicketUrl: integer("use_as_ticket_url", { mode: "boolean" }).notNull().default(false),
    useAsApplicationUrl: integer("use_as_application_url", { mode: "boolean" })
      .notNull()
      .default(false),
    useAsSource: integer("use_as_source", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    // Stored as seconds-epoch (mode: "timestamp"), consistent with the rest of
    // the operational tables. Migration 0040 backfilled raw-seconds values
    // by multiplying by 1000.
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by"),
  },
  (table) => [index("idx_udc_domain_type").on(table.domainType)]
);

// Error Logs table.
// timestamp: seconds-epoch (mode:"timestamp"). Migrated from raw seconds in 0043.
export const errorLogs = sqliteTable("error_logs", {
  id: text("id").primaryKey(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  level: text("level").notNull().default("error"),
  message: text("message").notNull(),
  context: text("context").default("{}"),
  url: text("url"),
  method: text("method"),
  statusCode: integer("status_code"),
  stackTrace: text("stack_trace"),
  userAgent: text("user_agent"),
  source: text("source"),
});

// Recommendations engine — drizzle/0042. See migration file for design notes.
export const recommendationRules = sqliteTable("recommendation_rules", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  ruleKey: text("rule_key").notNull().unique(),
  title: text("title").notNull(),
  rationaleTemplate: text("rationale_template").notNull(),
  // "red" | "yellow" | "blue"
  severity: text("severity").notNull(),
  category: text("category"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // seconds-epoch (mode:"timestamp"). Migrated from raw seconds in 0043.
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  // Last scan's unbounded match count. Drives the "Showing N of M" UI label
  // and lets us tell "still 0 matches" from "this rule has never run". Added
  // in 0046; engine writes on every scanAll().
  totalMatchCount: integer("total_match_count").default(0),
  lastScannedAt: integer("last_scanned_at", { mode: "timestamp" }),
  // Per-rule last-scan error message. NULL = last scan succeeded (or rule
  // has never scanned). Set to the thrown Error.message when scanAll() catches
  // a rule's run() failure; cleared to NULL on next successful scan. Added 0066.
  lastScanError: text("last_scan_error"),
});

export const recommendationItems = sqliteTable(
  "recommendation_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ruleId: text("rule_id")
      .notNull()
      .references(() => recommendationRules.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    payloadJson: text("payload_json"),
    // All five timestamps: seconds-epoch (mode:"timestamp"). Migrated from raw
    // seconds in 0043 alongside the other historically-seconds tables.
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull(),
    dismissedAt: integer("dismissed_at", { mode: "timestamp" }),
    dismissedUntil: integer("dismissed_until", { mode: "timestamp" }),
    dismissedReason: text("dismissed_reason"),
    actedAt: integer("acted_at", { mode: "timestamp" }),
  },
  (t) => [
    index("idx_recommendation_items_rule_id").on(t.ruleId),
    index("idx_recommendation_items_dismissed_until").on(t.dismissedUntil),
    index("idx_recommendation_items_last_seen_at").on(t.lastSeenAt),
  ]
);

// §10.2 enrichment audit trail (drizzle/0056). Append-only; one row per
// attempt (success or failure). source values: ai_workers | scraper |
// manual_admin | vendor_self | mcp_create. fieldsChanged is JSON array of
// field names. See src/lib/enrichment-log.ts for the writer.
export const enrichmentLog = sqliteTable(
  "enrichment_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    attemptedAt: integer("attempted_at", { mode: "timestamp" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    fieldsChanged: text("fields_changed"),
    notes: text("notes"),
    actorUserId: text("actor_user_id"),
  },
  (t) => [
    index("idx_enrichment_log_target").on(t.targetType, t.targetId),
    index("idx_enrichment_log_attempted_at").on(t.attemptedAt),
    index("idx_enrichment_log_source_status").on(t.source, t.status),
  ]
);

// §10.2 per-URL time-to-index cycle tracking (drizzle/0057). One row per
// IndexNow submission; firstCrawlAt + lagSeconds are populated by the sweep
// that joins against gscInspectionState.lastCrawlTime. Powers §10.3 median.
export const timeToIndexLog = sqliteTable(
  "time_to_index_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    url: text("url").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    indexnowSubmittedAt: integer("indexnow_submitted_at", { mode: "timestamp" }).notNull(),
    firstCrawlAt: integer("first_crawl_at", { mode: "timestamp" }),
    lagSeconds: integer("lag_seconds"),
    computedAt: integer("computed_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_time_to_index_log_url").on(t.url),
    index("idx_time_to_index_log_first_crawl_at").on(t.firstCrawlAt),
    index("idx_time_to_index_log_target").on(t.targetType, t.targetId),
  ]
);

// §10.2 curated competitor / aggregator domains (drizzle/0058). Replaces the
// hardcoded list previously inline in competitor-url-contamination rule.
// Loaded once per scan via loadCompetitorDomains in src/lib/competitor-domains.ts.
export const competitorDomains = sqliteTable(
  "competitor_domains",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    domain: text("domain").notNull().unique(),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by"),
  },
  (t) => [index("idx_competitor_domains_domain").on(t.domain)]
);

// §6.3 KPI state-machine history (drizzle/0059). One row per (kpi_name,
// computed_at) — the */10 cron in MCP Worker writes 5 rows per fire (one per
// KPI). The Overview reads the latest row per KPI for state-coloring; the
// action queue derives P0/P1 entries from the same source. Pruned to 90d.
export const kpiStateHistory = sqliteTable(
  "kpi_state_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kpiName: text("kpi_name").notNull(),
    computedAt: integer("computed_at", { mode: "timestamp" }).notNull(),
    // Nullable when the underlying data isn't flowing yet (e.g. time_to_index
    // before 10+ resolved samples). Pairs with state="INDETERMINATE".
    value: real("value"),
    state: text("state", {
      enum: ["GREEN", "YELLOW", "RED", "INDETERMINATE", "STALE"],
    }).notNull(),
    // 1 when this row's state differs from the previous row's state for the
    // same kpi_name. Drives the action-queue auto-resolve audit log entry.
    stateChangedFromPrevious: integer("state_changed_from_previous").notNull().default(0),
    // When the CURRENT continuous run of this state started. Carried forward
    // across rows of the same state; reset to computedAt when state changes.
    // Surfaces "first detected" date in the action queue for staleness.
    firstDetectedAt: integer("first_detected_at", { mode: "timestamp" }),
    // JSON blob: { numerator, denominator, window } for trace/debugging.
    meta: text("meta"),
  },
  (t) => [index("idx_kpi_state_history_name_at").on(t.kpiName, t.computedAt)]
);

// §6.3 Phase 2 GA4 liveness check log (drizzle/0060). One row per daily check
// from the MCP-Worker cron. Consecutive-failure count carries forward; alert
// fires after 2 consecutive critical/degraded results (anti-flap). Wired in
// src/app/api/admin/ga4-liveness/route.ts and mcp-server's scheduled() handler.
export const ga4LivenessLog = sqliteTable(
  "ga4_liveness_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
    // 'green' = data ≤24h old; 'degraded' = 24-48h; 'critical' = >48h or null.
    status: text("status", { enum: ["green", "degraded", "critical"] }).notNull(),
    // YYYY-MM-DD of the most recent GA4 day with users>0; null = no data in 7d.
    maxDataDate: text("max_data_date"),
    dataAgeSeconds: integer("data_age_seconds"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // 1 when this row's check triggered an admin_actions ga4.liveness_alert.
    alertFired: integer("alert_fired").notNull().default(0),
  },
  (t) => [index("idx_ga4_liveness_log_checked_at").on(t.checkedAt)]
);

// Inbound email persistence — drizzle/0072. Every message received by
// the MCP Worker's email() entrypoint gets a row here, driving the
// InboundEmailWorkflow's status state machine and providing an
// admin-queryable inbox. See docs/inbound-email.md for intent vocab.
export const inboundEmails = sqliteTable(
  "inbound_emails",
  {
    id: text("id").primaryKey(),
    receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject"),
    /** submit | correction | support | press | unsubscribe | unknown */
    intent: text("intent").notNull(),
    /** received | processing | replied | forwarded | failed */
    status: text("status").notNull().default("received"),
    workflowInstanceId: text("workflow_instance_id"),
    bodyTextExcerpt: text("body_text_excerpt"),
    /** URL extracted from the body by pickPrimaryUrl in the entrypoint —
     *  the submit handler reads this rather than re-parsing the excerpt. */
    parsedUrl: text("parsed_url"),
    attachmentCount: integer("attachment_count").notNull().default(0),
    rawSize: integer("raw_size"),
    error: text("error"),
    /** RFC 5322 Message-ID extracted by PostalMime. Used to dedup
     *  re-delivered inbound mail (the entrypoint INSERTs with
     *  onConflictDoNothing keyed on this column). Nullable because not
     *  every sender includes a Message-ID — those messages skip dedup. */
    messageId: text("message_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_inbound_emails_received_at").on(t.receivedAt),
    index("idx_inbound_emails_intent").on(t.intent),
    index("idx_inbound_emails_status").on(t.status),
    index("idx_inbound_emails_from").on(t.fromAddress),
    // Partial-unique on message_id (NULLs are exempt — SQLite already
    // treats them as distinct, but spelled explicitly via WHERE for
    // clarity). Added 0073 for inbound idempotency.
    uniqueIndex("uq_inbound_emails_message_id")
      .on(t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
  ]
);

// Type exports
export type User = typeof users.$inferSelect;
export type Venue = typeof venues.$inferSelect;
export type Promoter = typeof promoters.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type EventVendor = typeof eventVendors.$inferSelect;
export type EventDay = typeof eventDays.$inferSelect;
export type UserFavorite = typeof userFavorites.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type ErrorLog = typeof errorLogs.$inferSelect;
export type EventSchemaOrg = typeof eventSchemaOrg.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type BlogPost = typeof blogPosts.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type HealthIssue = typeof healthIssues.$inferSelect;
export type HealthIssueSnooze = typeof healthIssueSnoozes.$inferSelect;
export type GscInspectionState = typeof gscInspectionState.$inferSelect;
export type IndexnowSubmission = typeof indexnowSubmissions.$inferSelect;
export type PendingSearchPing = typeof pendingSearchPings.$inferSelect;
export type UrlDomainClassification = typeof urlDomainClassifications.$inferSelect;
export type RecommendationRule = typeof recommendationRules.$inferSelect;
export type RecommendationItem = typeof recommendationItems.$inferSelect;
export type EnrichmentLog = typeof enrichmentLog.$inferSelect;
export type TimeToIndexLog = typeof timeToIndexLog.$inferSelect;
export type CompetitorDomain = typeof competitorDomains.$inferSelect;
export type InboundEmail = typeof inboundEmails.$inferSelect;
