import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
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
  // Primary role — kept for back-compat with the ~100 existing
  // `session.user.role === X` consumers. The canonical source of truth
  // for "what roles does this user have" is `user_roles` (drizzle/0089),
  // exposed via `session.user.roles[]` and the hasRole() helper. PR 2
  // (planned) will migrate the remaining consumers to use roles[].
  role: text("role", { enum: ["ADMIN", "PROMOTER", "VENDOR", "USER"] })
    .default("USER")
    .notNull(),
  emailVerified: integer("email_verified", { mode: "timestamp" }),
  image: text("image"),
  oauthProvider: text("oauth_provider"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

/**
 * Many-to-many role grants. A user can hold multiple roles
 * (e.g., VENDOR + PROMOTER for someone who runs a craft business AND
 * organizes a small show). Backfilled from users.role 1:1 in
 * drizzle/0089 so every existing user starts with exactly one grant
 * matching their primary role.
 *
 * Granting paths:
 *  - Email-match self-service claim: when a verified user clicks
 *    "Claim this listing" and the entity's contact_email matches
 *    their own, the claim API writes both the entity update AND a
 *    user_roles row for the corresponding role.
 *  - Admin override: planned MCP `set_user_roles` tool for cases
 *    self-service doesn't cover.
 *
 * UNIQUE(user_id, role) makes re-grants idempotent. CASCADE on
 * user_id deletion wipes the grants; SET NULL on granted_by keeps
 * the audit row when the granter is deleted.
 */
export const userRoles = sqliteTable(
  "user_roles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["USER", "VENDOR", "PROMOTER", "ADMIN"] }).notNull(),
    grantedAt: integer("granted_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    uniqueUserRole: uniqueIndex("user_roles_user_role_unique").on(t.userId, t.role),
    userIdIdx: index("idx_user_roles_user_id").on(t.userId),
    roleIdx: index("idx_user_roles_role").on(t.role),
  })
);

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
    // Cross-zone columns (drizzle/0112, P3a — 2026-06-06). Every existing
    // venue row defaults to US-Eastern via the migration's NOT NULL DEFAULT
    // clauses, so this is zero-behavior-change at deploy. Phase 3b will
    // thread these per-row values through the helper call sites; today
    // they're capability-only.
    timezone: text("timezone").default("America/New_York").notNull(), // IANA zone
    locale: text("locale").default("en-US").notNull(), // BCP 47 locale tag
    country: text("country").default("US").notNull(), // ISO 3166-1 alpha-2
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    // IMG1 §1b Phase 1 (2026-06-08) — per-image focal-point override.
    // Range 0.0–1.0 (0,0 = top-left, 1,1 = bottom-right). Default 0.5/0.5
    // = center, matching the pre-IMG1 dumb-crop behavior. Consumed by
    // cdnImage() as `gravity=${x}x${y}` when non-default.
    imageFocalX: real("image_focal_x").notNull().default(0.5),
    imageFocalY: real("image_focal_y").notNull().default(0.5),
  },
  (table) => [
    index("idx_venues_status").on(table.status),
    // Partial UNIQUE index from drizzle/0016 — multiple venues CAN have NULL
    // google_place_id (optional field), but if a venue has one it must be
    // unique. Same partial-index pattern as uq_inbound_emails_message_id.
    uniqueIndex("idx_venues_google_place_id_unique")
      .on(table.googlePlaceId)
      .where(sql`${table.googlePlaceId} IS NOT NULL`),
  ]
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
  // IMG1 §1b Phase 1 — applies to logo_url for promoters (square-ish, but
  // operators may want focal-point on non-square uploads). See events table.
  imageFocalX: real("image_focal_x").notNull().default(0.5),
  imageFocalY: real("image_focal_y").notNull().default(0.5),
});

// Event series — EH3 P0 (drizzle/0127, 2026-06-21). Thin parent table: the
// stable identity + canonical-metadata home for a recurring event. Each `events`
// row is one dated OCCURRENCE under a series (events.series_id) and may override
// these defaults for its specific year. NULL series_id = standalone one-off.
// No reads at P0 — backfill (P1) and the series landing/SEO/tools (P2–P3) ship
// later. See docs/eh3-scoping.md.
export const eventSeries = sqliteTable(
  "event_series",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Year-agnostic canonical URL slug (`/events/<canonical_slug>`), e.g.
    // "newport-international-boat-show". Branded Slug per the #120 convention.
    canonicalSlug: text("canonical_slug").$type<Slug>().notNull().unique(),
    name: text("name").notNull(),
    // Series-level defaults; an occurrence may override. Nullable FKs (a default,
    // not a requirement) — unlike events.promoterId which stays NOT NULL.
    venueId: text("venue_id").references(() => venues.id, { onDelete: "set null" }),
    promoterId: text("promoter_id").references(() => promoters.id, { onDelete: "set null" }),
    recurrenceRule: text("recurrence_rule"),
    description: text("description"),
    imageUrl: text("image_url"),
    categories: text("categories").default("[]"),
    tags: text("tags").default("[]"),
    primaryAudience: text("primary_audience", { enum: ["PUBLIC", "TRADE", "MEMBERS"] })
      .notNull()
      .default("PUBLIC"),
    publicAccess: text("public_access", { enum: ["OPEN", "CLOSED"] })
      .notNull()
      .default("OPEN"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_event_series_venue_id").on(table.venueId),
    index("idx_event_series_promoter_id").on(table.promoterId),
  ]
);

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
    // External source tracking for synced events. Three fields:
    //   - sourceName: legacy free-form label (kept for back-compat reads);
    //     historically mixed origin domains + ingestion methods + notes.
    //   - sourceDomain: canonical origin domain (lowercased, no www, no path).
    //     Populated by src/lib/source-classification.ts at write time.
    //   - ingestionMethod: enum-ish — direct_scrape / email_submission /
    //     vendor_submission / community_suggestion / web_research /
    //     admin_manual / aggregator_import. Drives per-method reliability
    //     scoring without parsing sourceName at query time.
    // See drizzle/0090_events_source_split.sql for the migration that adds
    // the two new columns; backfill runs via the admin sweep endpoint.
    sourceName: text("source_name"), // legacy label, e.g. "mainefairs.net"
    sourceDomain: text("source_domain"), // canonical hostname only
    ingestionMethod: text("ingestion_method"), // enum (see comment above)
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
    // Idempotency marker for the "your submission was approved" email
    // (drizzle/0077). NULL = never notified; the notification helper
    // only fires when this is NULL AND status='APPROVED' AND
    // suggester_email IS NOT NULL. See src/lib/approval-notification.ts.
    approvalNotifiedAt: integer("approval_notified_at", { mode: "timestamp" }),
    // "Tried, don't re-select" marker for the og:image sweep (drizzle/0092).
    // Set on every iteration of POST /api/admin/og-image/sweep regardless
    // of outcome (updated / would_update / skipped_*). The SELECT filters
    // on `IS NULL` so each event is attempted exactly once — without this
    // the sweep loops forever on the first N events when they all skip
    // the Phase 2a gates (Item 13 follow-up after the 0% yield preview
    // surfaced the loop). To retry an attempted event after Phase 2b's
    // dead-URL fallback lands, NULL the column for the target rows.
    ogImageSweepAttemptedAt: integer("og_image_sweep_attempted_at", { mode: "timestamp" }),
    // K3 (analyst, 2026-05-31) — merge tombstone pointer (drizzle/0095).
    // Set by mergeEvents() when an operator collapses a duplicate into a
    // keeper. The merge transaction also: renames the duplicate's slug to
    // `<orig>-merged-<id8>`, writes an event_slug_history row so the
    // original slug 301s to the keeper, and marks the duplicate's status
    // = 'REJECTED'. Reads should treat `merged_into IS NOT NULL` as
    // "this row is a tombstone, redirect to the keeper". Self-FK uses
    // plain text per the parentEmailId convention — the FK + ON DELETE
    // SET NULL semantics live in the SQL migration. */
    mergedInto: text("merged_into"),
    // K2 part 5 (analyst, 2026-05-31) — possible-duplicate pointer
    // (drizzle/0096). Set by the email pipeline's enrich-or-flag step
    // when dedup found a MEDIUM-confidence match (city_state_date or
    // similar_name_date), distinct from HIGH-confidence matches
    // (exact_url, venue_date) which short-circuit to an already-exists
    // reply. The flagged PENDING goes into the admin review queue at
    // /admin/possible-duplicates; the operator either clears the
    // pointer (confirm distinct) or calls merge_events with this row
    // as the duplicate (confirm same).
    //
    // Behavior wiring is DEFERRED to a follow-up PR (tracked as #286, still
    // open as of 2026-06) — this PR lands only the column so Part 6's sweep
    // can reference it and a future workflow PR can set it. As of 2026-06
    // NOTHING writes this column yet; the email pipeline's MEDIUM-confidence
    // branch is the intended writer. Treat a non-null value as authoritative
    // only once that wiring exists. Self-FK at SQL level per the
    // parentEmailId convention.
    possibleDuplicateOf: text("possible_duplicate_of"),
    // K27 (drizzle/0124, 2026-06-15) — auto-rollover provenance pointer. Set on
    // a TENTATIVE next-occurrence edition created by rolloverEventIfRecurring()
    // when its source event transitions to OCCURRED. Points at the source (the
    // edition that just passed). Forensic link + lets the operator reconcile
    // (§7) cheaply find auto-rolled rows. Self-FK ON DELETE SET NULL per the
    // mergedInto/possibleDuplicateOf convention — defined at the SQL level.
    rolledFromEventId: text("rolled_from_event_id"),
    // EH3 P0 (drizzle/0127, 2026-06-21) — occurrence → series link. NULL =
    // standalone one-off (every existing row at deploy). Set by P1 backfill.
    // ON DELETE SET NULL at the SQL level (mirrors rolledFromEventId).
    seriesId: text("series_id").references(() => eventSeries.id, { onDelete: "set null" }),
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
    // UX-R1 / C1 (drizzle/0098, 2026-06-01 EVE). Operator-action queue
    // marker — set by scripts/backfill-event-days-from-description.ts when
    // expandCadence() can't determine a recurrence pattern from the
    // description. Mirrors inbound_emails.flagged_for_review at line 1497.
    // Distinct from gateFlags (pre-ingest decision trace); this is a
    // POST-ingest review queue. "Only SET the flag here — never clear it"
    // (the K7 idempotent-notification pattern); operators clear after
    // triage via the /admin/events?flagged=1 filter.
    flaggedForReview: integer("flagged_for_review").notNull().default(0),
    // TAX1 Phase 1 (drizzle/0100, 2026-06-02). Two ORTHOGONAL audience
    // questions today's `categories[]` can't answer.
    //   primaryAudience — who is the event ORIENTED toward
    //   publicAccess    — can a non-member-of-the-public attend at all
    // These compose freely: TRADE+OPEN = "industry show, public may pay
    // in" (Maine PHCC Expo); TRADE+CLOSED = credential-gated B2B;
    // MEMBERS+CLOSED = restricted association meeting; MEMBERS+OPEN +
    // accessNotes = members' event with a public-marketplace window.
    // PUBLIC+OPEN is the permissive default = today's pre-migration
    // semantics, so existing rows are invisible at deploy. Phase 2 hand-
    // backfills the known restricted set; Phase 3 wires the public
    // badge + JSON-LD `audience` mapping. NEVER down-rank MEMBERS/TRADE
    // in vendor-recommendation surfaces — "restricted audience +
    // exhibitor floor + matching demographic" is a known-good pattern
    // (LeafFilter × MAR). Audience is informational, not a quality
    // signal.
    primaryAudience: text("primary_audience", { enum: ["PUBLIC", "TRADE", "MEMBERS"] })
      .notNull()
      .default("PUBLIC"),
    publicAccess: text("public_access", { enum: ["OPEN", "CLOSED"] })
      .notNull()
      .default("OPEN"),
    // Free-text nuance the enum pair can't hold (e.g. "members + public
    // for Saturday plant sale 9am–1pm"). NULL = the audience/access pair
    // is fully self-describing for this event.
    accessNotes: text("access_notes"),
    // Logistics axis — separate from audience/access. Defaults false.
    // Drives a future "Registration required — see ticket URL" badge
    // in Phase 3 (paired with the audience badge composition).
    registrationRequired: integer("registration_required", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    // IMG1 §1b Phase 1 (2026-06-08) — per-image focal-point override.
    // Applies to image_url (the hero/card photo). See venues table for the
    // full comment. Cards + heroes read this and pass to cdnImage as
    // `gravity=${x}x${y}` when non-default; matches Eventbrite's
    // `fp-x`/`fp-y` UX pattern. Defaults to center, so existing events
    // render identically until an operator sets a focal point.
    imageFocalX: real("image_focal_x").notNull().default(0.5),
    imageFocalY: real("image_focal_y").notNull().default(0.5),
    // SYN1 (drizzle/0122) — per-event syndication version. Monotonic counter
    // bumped in the SAME batch as any mutation that changes a mirrored field
    // (this event's name/dates, OR — via venue fan-out — its venue's
    // name/address/city/state/zip). This is the `event_version` consumers
    // dedup on ("highest version wins"); a venue edit must bump every affected
    // event, which is why it's a real column, not derivable from the outbox.
    syndicationVersion: integer("syndication_version").notNull().default(0),
    // OPE-13 (vendor-roster rails) — persistent per-event roster-research state.
    // The keystone of the vendor-roster backfill system: today the only signal
    // is the list_event_vendors count, which can't tell "no public list exists"
    // from "never researched", so every sweep re-researches the same dead-ends.
    // NULL = never evaluated (the implicit pre-rails state for every existing
    // row at deploy). The just-occurred sweep (mcp-server/src/event-occurred-
    // sweep.ts) sets NEEDS_RESEARCH; the analyst research worker sets the
    // terminal states via set_vendor_roster_status. NO_PUBLIC_LIST is what makes
    // the process CONVERGE — a researched dead-end stays sticky instead of being
    // re-tried. PARTIAL + vendorRosterOffset lets a capped/incomplete run resume
    // exactly where it left off (e.g. the Foxboro 174-roster finished over two
    // passes).
    vendorRosterStatus: text("vendor_roster_status", {
      enum: ["NEEDS_RESEARCH", "HAS_ROSTER", "NO_PUBLIC_LIST", "PARTIAL"],
    }),
    vendorRosterCheckedAt: integer("vendor_roster_checked_at", { mode: "timestamp" }),
    vendorRosterSourceUrl: text("vendor_roster_source_url"),
    // Resume point for PARTIAL rosters — the source-list offset the last run
    // reached. Meaningful only when vendorRosterStatus = 'PARTIAL'.
    vendorRosterOffset: integer("vendor_roster_offset"),
  },
  (table) => [
    index("idx_events_status_startdate").on(table.status, table.startDate),
    index("idx_events_venueid").on(table.venueId),
    index("idx_events_promoterid").on(table.promoterId),
    index("idx_events_state_code").on(table.stateCode),
    index("idx_events_completeness_score").on(table.completenessScore),
    index("idx_events_lifecycle_status").on(table.lifecycleStatus),
    // K3 (drizzle/0095) — partial index for "show me events merged into X"
    // queries + the admin_actions reverse lookup. Most events have NULL
    // mergedInto so the partial keeps the index small.
    index("idx_events_merged_into")
      .on(table.mergedInto)
      .where(sql`${table.mergedInto} IS NOT NULL`),
    // K2 part 5 (drizzle/0096) — partial index supports the
    // /admin/possible-duplicates queue + the Part 6 sweep's
    // cross-check ("don't surface clusters that are already flagged").
    index("idx_events_possible_duplicate_of")
      .on(table.possibleDuplicateOf)
      .where(sql`${table.possibleDuplicateOf} IS NOT NULL`),
    // K27 (drizzle/0124) — partial index for "what was rolled from event X"
    // reverse lookups + the reconcile pass. Most events are not auto-rolled,
    // so the partial keeps it small.
    index("idx_events_rolled_from_event_id")
      .on(table.rolledFromEventId)
      .where(sql`${table.rolledFromEventId} IS NOT NULL`),
    // UX-R1 / C1 (drizzle/0098) — partial index supporting the
    // /admin/events?flagged=1 operator review queue. Only the "1" rows
    // are indexed, mirroring the inbound_emails.flagged_for_review pattern.
    index("idx_events_flagged_for_review")
      .on(table.flaggedForReview)
      .where(sql`${table.flaggedForReview} = 1`),
    // OPE-13 — partial index for the research-queue scan (analyst sweep drains
    // NEEDS_RESEARCH) and the coverage metric. Most rows are NULL (never
    // evaluated), so the partial keeps the index small and the queue read cheap.
    index("idx_events_vendor_roster_status")
      .on(table.vendorRosterStatus)
      .where(sql`${table.vendorRosterStatus} IS NOT NULL`),
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
  // EH2.1 (drizzle/0121, 2026-06-09) — optional brand display override.
  // Resolved at render time via displayVendorName() in @takemetothefair/utils.
  // NULL = render business_name as today (zero behavior change for ~99% of rows).
  displayName: text("display_name"),
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
  // EH1 Phase 1 — vendor hierarchy + relationship model.
  // Originally added in drizzle/0106 (minimal model: role + parent_vendor_id
  // + default_display/override_permitted/display_preference). Extended in
  // drizzle/0107 (2026-06-05) to the full relationship model approved in
  // Dev-Spec-Vendor-Hierarchy-Phase1-2026-06-04.md: brand vs operator
  // parent split, 8-shape relationship_type enum, alias links, and a
  // wider display vocabulary that can express operator_parent + both.
  //
  // `role` stays as a fast NATIONAL/LOCAL_OFFICE/INDEPENDENT discriminator
  // (existing render page + sitemap SQL + admin form read it heavily).
  role: text("role", { enum: ["NATIONAL", "LOCAL_OFFICE", "INDEPENDENT"] })
    .notNull()
    .default("INDEPENDENT"),
  // Brand parent: who the consumer sees on signage (the national brand).
  // The display resolver consumes this one. NULL for INDEPENDENT and
  // for brand-parent rows themselves.
  brandParentVendorId: text("brand_parent_vendor_id").references(
    (): AnySQLiteColumn => vendors.id,
    { onDelete: "set null" }
  ),
  // Operator parent: who signs contracts / pays booth fees (e.g. Esler
  // Companies). Drives sales-motion + portfolio analytics, NOT public
  // display. Often equal to brandParentVendorId for branch shapes;
  // distinct for shape C (franchise with multi-market operator).
  operatorParentVendorId: text("operator_parent_vendor_id").references(
    (): AnySQLiteColumn => vendors.id,
    { onDelete: "set null" }
  ),
  // Alias link: "this row IS that row, different spelling." Resolved
  // transparently by resolveAlias() in src/lib/vendor-hierarchy.ts; the
  // aliased row is also soft-deleted (deletedAt + redirectToVendorId)
  // so middleware can 301-redirect its URL to the canonical.
  aliasOfVendorId: text("alias_of_vendor_id").references((): AnySQLiteColumn => vendors.id, {
    onDelete: "set null",
  }),
  // 8 shapes from the design doc — branch (W-2), franchise (independent
  // operator), dealer (reseller), member (cooperative), agent (1099),
  // employee_branch (small-corp branch), government (gov entity),
  // independent (default — no relationship). SQL CHECK enforces.
  relationshipType: text("relationship_type", {
    enum: [
      "branch",
      "franchise",
      "dealer",
      "member",
      "agent",
      "employee_branch",
      "government",
      "independent",
    ],
  })
    .notNull()
    .default("independent"),
  // Parent-side: what the brand-parent picks as its offices' default
  // display target. 'self' = each office is its own canonical surface;
  // 'brand_parent' = offices canonical-up to the brand hub; 'both' =
  // office is canonical but also shown under the brand. NULL on
  // non-parent rows.
  defaultChildDisplay: text("default_child_display", {
    enum: ["self", "brand_parent", "both"],
  }),
  // Child-side: parent-controlled gate. Default 0 — the parent's
  // defaultChildDisplay always wins until the parent explicitly grants
  // override. A vendor claim grants edit rights but NEVER bypasses this
  // gate (spec §4.4 — parent's gate always wins).
  displayOverridePermitted: integer("display_override_permitted", { mode: "boolean" })
    .notNull()
    .default(false),
  // Child-side: the office's own requested preference. Honored only when
  // displayOverridePermitted=true AND displayMode != 'inherit'. INHERIT
  // falls through to parent.defaultChildDisplay.
  displayMode: text("display_mode", {
    enum: ["inherit", "self", "brand_parent", "operator_parent", "both"],
  }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  // IMG1 §1b Phase 1 — applies to logo_url. See events table comment.
  imageFocalX: real("image_focal_x").notNull().default(0.5),
  imageFocalY: real("image_focal_y").notNull().default(0.5),
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

// Venue slug history — mirrors eventSlugHistory for /venues/[slug].
// drizzle/0109 (E remainder, Dev backlog 2026-06-05). Populated by
// merge_venue so the merged-away slug 301-redirects to the keeper via
// the slug-history walker in src/middleware.ts.
export const venueSlugHistory = sqliteTable(
  "venue_slug_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    venueId: text("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    oldSlug: text("old_slug").$type<Slug>().notNull(),
    newSlug: text("new_slug").$type<Slug>().notNull(),
    changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
    changedBy: text("changed_by"),
  },
  (t) => ({
    oldSlugIdx: index("idx_venue_slug_history_old_slug").on(t.oldSlug),
    venueIdIdx: index("idx_venue_slug_history_venue_id").on(t.venueId),
  })
);

// Promoter slug history — mirrors eventSlugHistory for /promoters/[slug].
// drizzle/0109 (E remainder, Dev backlog 2026-06-05). Same shape as
// venueSlugHistory; the merge_promoter tool writes here even though it
// hard-deletes the duplicate row (ON DELETE CASCADE then runs, which is
// fine — the rows that mattered for redirects existed at the moment of
// the merge, and the cascade only fires once the row is gone).
export const promoterSlugHistory = sqliteTable(
  "promoter_slug_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    promoterId: text("promoter_id")
      .notNull()
      .references(() => promoters.id, { onDelete: "cascade" }),
    oldSlug: text("old_slug").$type<Slug>().notNull(),
    newSlug: text("new_slug").$type<Slug>().notNull(),
    changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
    changedBy: text("changed_by"),
  },
  (t) => ({
    oldSlugIdx: index("idx_promoter_slug_history_old_slug").on(t.oldSlug),
    promoterIdIdx: index("idx_promoter_slug_history_promoter_id").on(t.promoterId),
  })
);

// Blog slug history — mirrors eventSlugHistory for /blog/[slug].
// drizzle/0087. blog_post_id points at the SUCCESSOR post so the FK
// cascade behaves sensibly across both the rename case (post still
// lives at its new slug) and the consolidation case (deleted post's
// slug redirects to a different, living successor).
export const blogSlugHistory = sqliteTable(
  "blog_slug_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    blogPostId: text("blog_post_id")
      .notNull()
      .references(() => blogPosts.id, { onDelete: "cascade" }),
    oldSlug: text("old_slug").$type<Slug>().notNull(),
    newSlug: text("new_slug").$type<Slug>().notNull(),
    changedAt: integer("changed_at", { mode: "timestamp" }).notNull(),
    changedBy: text("changed_by"),
  },
  (t) => ({
    oldSlugIdx: index("idx_blog_slug_history_old_slug").on(t.oldSlug),
    blogPostIdIdx: index("idx_blog_slug_history_blog_post_id").on(t.blogPostId),
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
    // F — K18 Phase 1 (drizzle/0114, 2026-06-06). Optional per-occurrence
    // scoping for recurring-event series. NULL = series-wide (regular
    // participant, applies to every occurrence — preserves pre-K18
    // behavior). Set = vendor participates on THIS event_day only.
    // ON DELETE CASCADE — when an event_day is deleted, its date-scoped
    // vendor links go with it; series-wide (NULL) links are untouched.
    eventDayId: text("event_day_id").references(() => eventDays.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_eventvendors_eventid_status").on(table.eventId, table.status),
    index("idx_eventvendors_vendorid").on(table.vendorId),
    // K18 Phase 1: new index shapes for per-occurrence queries.
    index("idx_eventvendors_event_day_id").on(table.eventId, table.eventDayId),
    index("idx_eventvendors_vendor_day_id").on(table.vendorId, table.eventDayId),
    // K18 Phase 1 replaces the unconditional (event_id, vendor_id) unique
    // with two partial indexes (SQLite NULL-distinct gotcha — a bare
    // UNIQUE(event_id, vendor_id, event_day_id) would NOT prevent two
    // series-wide rows for the same pair). Partial (a) enforces at most
    // one series-wide row per (event, vendor); partial (b) enforces at
    // most one per-day row per (event, vendor, event_day_id). A vendor
    // linked both series-wide AND on a specific date is intentionally
    // allowed — "regular participant, plus has a featured slot on Jul 3".
    uniqueIndex("idx_eventvendors_series_unique")
      .on(table.eventId, table.vendorId)
      .where(sql`${table.eventDayId} IS NULL`),
    uniqueIndex("idx_eventvendors_perday_unique")
      .on(table.eventId, table.vendorId, table.eventDayId)
      .where(sql`${table.eventDayId} IS NOT NULL`),
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
  // DQ4 (drizzle/0118, 2026-06-08) — openTime / closeTime are nullable.
  // NULL means "hours not yet confirmed" (no fabricated default). Ingest
  // paths that previously defaulted to "10:00"/"18:00" or "09:00"/"17:00"
  // now write NULL and set events.flaggedForReview=1 for operator triage.
  // Render layer (DailyScheduleDisplay) falls back to "Hours not yet
  // confirmed" when both are null on a row. See email §C and runbook
  // docs/runbooks/dq4-9-5-daily-sweep.md.
  openTime: text("open_time"), // "HH:MM" 24-hour format, or NULL
  closeTime: text("close_time"), // "HH:MM" 24-hour format, or NULL
  notes: text("notes"),
  closed: integer("closed", { mode: "boolean" }).default(false),
  vendorOnly: integer("vendor_only", { mode: "boolean" }).default(false),
  // F2 (drizzle/0120, 2026-06-08) — per-occurrence image + focal-point.
  // A series event can carry distinct art per occurrence (e.g. seasonal
  // farmers markets with different posters per month). v1 consumers:
  // admin create_event_day / update_event_day MCP tools accept these
  // args. Deferred for v1: public per-day image strip, JSON-LD
  // subEvent.image, series-event grid using per-occurrence art.
  imageUrl: text("image_url"),
  imageFocalX: real("image_focal_x").notNull().default(0.5),
  imageFocalY: real("image_focal_y").notNull().default(0.5),
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
    // SHA-256 hex digest of the random 32-byte confirmation token. The raw
    // token only exists in the confirmation email URL — see
    // src/lib/email/newsletter-confirm-token.ts. NULL once the subscription
    // is confirmed (token consumed and cleared).
    confirmationTokenHash: text("confirmation_token_hash"),
    // Confirmation token expiry — 24h after issue. NULL when no token is
    // outstanding.
    confirmationExpires: integer("confirmation_expires", { mode: "timestamp" }),
  },
  (table) => ({
    emailIdx: index("idx_newsletter_email").on(table.email),
    confirmationTokenHashIdx: index("idx_newsletter_confirmation_token_hash").on(
      table.confirmationTokenHash
    ),
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
    targetType: text("target_type", { enum: ["EVENT", "VENDOR", "VENUE", "BLOG_POST"] }).notNull(),
    targetSlug: text("target_slug").notNull(),
    targetId: text("target_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    // Stamped after we successfully fire a promoter blog-mention email for
    // this row. NULL means we haven't notified yet (or this link type isn't
    // notifiable). See src/lib/content-links-sync.ts for the firing logic.
    notifiedAt: integer("notified_at", { mode: "timestamp" }),
  },
  (table) => ({
    // Migration drizzle/0086 created this as UNIQUE INDEX; the schema
    // declaration must mirror it so future drizzle-kit diffs stay clean
    // (same hygiene reason as the user_roles unique index above).
    uniqueIdx: uniqueIndex("idx_content_links_unique").on(
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
    // F1 (drizzle/0119, 2026-06-08) — focal-point columns. Last entity
    // type to join the focal-point system (events/venues/vendors/promoters
    // got them in drizzle/0115). Default 0.5/0.5 = center; BlogPostCard
    // reads via focalPointGravity() which short-circuits center → undefined
    // so pre-F1 derivative cache keys are preserved.
    imageFocalX: real("image_focal_x").notNull().default(0.5),
    imageFocalY: real("image_focal_y").notNull().default(0.5),
    status: text("status", { enum: ["DRAFT", "PUBLISHED"] })
      .default("DRAFT")
      .notNull(),
    publishDate: integer("publish_date", { mode: "timestamp" }),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    // Homepage ranking inputs (drizzle/0128, 2026-06-23). view_count is a coarse
    // popularity signal incremented on the ISR-cached blog detail render (counts
    // regenerations, not raw views — relative, fine for ranking). featured is an
    // editorial pin fed to the scorer as a strong weighted boost. See
    // src/lib/blog/homepage-ranking.ts.
    viewCount: integer("view_count").notNull().default(0),
    featured: integer("featured", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_blogposts_status_publishdate").on(table.status, table.publishDate),
    index("idx_blogposts_slug").on(table.slug),
    index("idx_blogposts_authorid").on(table.authorId),
    index("idx_blogposts_status_featured").on(table.status, table.featured),
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
  // EH3 P0 — the series this occurrence belongs to (NULL for standalone events).
  series: one(eventSeries, { fields: [events.seriesId], references: [eventSeries.id] }),
  eventVendors: many(eventVendors),
  eventDays: many(eventDays),
  schemaOrg: one(eventSchemaOrg, { fields: [events.id], references: [eventSchemaOrg.eventId] }),
  dataCitations: many(eventDataCitations),
}));

// EH3 P0 — a series owns many dated occurrences (its events rows) and carries
// default venue/promoter. No reads wired yet; defined for P2 query ergonomics.
export const eventSeriesRelations = relations(eventSeries, ({ one, many }) => ({
  venue: one(venues, { fields: [eventSeries.venueId], references: [venues.id] }),
  promoter: one(promoters, { fields: [eventSeries.promoterId], references: [promoters.id] }),
  occurrences: many(events),
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

// K10 (drizzle/0097, analyst 2026-06-01 EVE) — Search Console "milestone"
// emails. Holds the "Congrats on X clicks in 28 days" growth notifications
// Google sends. Source-of-truth for the SEO milestone growth chart on
// /admin/analytics (B2 / K11). Backs the line chart of `threshold` over
// `email_date`, plus the four stat cards (latest / earliest / count /
// May ramp). siteUrl filter is critical — the table also holds milestones
// for the Maine Cardworks property; the MMATF chart must scope by
// site_url='https://meetmeatthefair.com/'.
//
// Nothing populates this automatically (MMATF doesn't read the inbox);
// rows are added manually as Google sends the emails. A future cron
// could snapshot the GSC clicks figure and INSERT a row when a threshold
// is first crossed.
export const gscMilestoneEmails = sqliteTable(
  "gsc_milestone_emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    metric: text("metric").notNull().default("clicks"),
    windowDays: integer("window_days").notNull().default(28),
    threshold: integer("threshold").notNull(),
    // Google's cited impact date — nullable because not every milestone
    // email includes one explicitly.
    reachedDate: text("reached_date"),
    emailDate: text("email_date").notNull(),
    siteUrl: text("site_url").notNull().default("https://meetmeatthefair.com/"),
    source: text("source").notNull().default("google_search_console_email"),
    note: text("note"),
    // SECONDS-epoch (unixepoch() in SQL default) per
    // [[reference_drizzle_timestamp_mode_is_seconds]] — mode:"timestamp"
    // gives the same shape as createdAt fields on neighboring tables.
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // UNIQUE on (metric, windowDays, threshold, emailDate) so re-running
    // a backfill or re-receiving a duplicate Google email doesn't create
    // duplicate rows. Mirrors drizzle/0097.
    uniqueIndex("idx_gsc_milestone_unique").on(t.metric, t.windowDays, t.threshold, t.emailDate),
  ]
);

// B2 (Dev backlog 2026-06-05): GSC monthly performance snapshots — the
// longer-window counterpart to gsc_milestone_emails. Stores month-over-
// month rollups Google emails as the "How your site performed in <month>"
// report (clicks/impressions/CTR plus optional device split). Reproduced
// in repo from an out-of-band prod create the same way K10 did for
// gsc_milestone_emails — see drizzle/0108_gsc_monthly_summary.sql.
//
// May 2026 row seeded so far (668 clicks / 40.1K impressions / 1.67% CTR).
// Nothing populates this automatically yet; rows added manually as Google
// sends the emails. A future cron / inbox parser could snapshot
// programmatically.
export const gscMonthlySummary = sqliteTable(
  "gsc_monthly_summary",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    yearMonth: text("year_month").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    pagesWithFirstImpressions: integer("pages_with_first_impressions"),
    desktopClicks: integer("desktop_clicks"),
    mobileClicks: integer("mobile_clicks"),
    tabletClicks: integer("tablet_clicks"),
    siteUrl: text("site_url").notNull().default("https://meetmeatthefair.com/"),
    source: text("source").notNull().default("google_search_console_email"),
    note: text("note"),
    // SECONDS-epoch (unixepoch() in SQL default) per
    // [[reference_drizzle_timestamp_mode_is_seconds]] — matches the
    // gscMilestoneEmails sibling's createdAt shape.
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // UNIQUE on (siteUrl, yearMonth) — one monthly row per property per
    // month; re-receiving a duplicate Google email or re-running a
    // backfill is idempotent. Mirrors drizzle/0108.
    uniqueIndex("idx_gsc_monthly_unique").on(t.siteUrl, t.yearMonth),
  ]
);

// A12 (drizzle/0131, analyst 2026-06-26) — GSC Search Analytics time-series.
// The live `searchAnalytics/query` feed (src/lib/search-console.ts) is fetched
// per-request and never persisted, so there's no history to chart WoW movement
// or attribute lifts to ships, and Google only retains ~16 months before a
// window rolls off permanently. This table is the durable trend store: one row
// per (date, query, page) per day, upserted daily by a cron (last few days are
// re-upserted because GSC revises recent dates retroactively). Keep the live
// tools as-is for ad-hoc; this table is for trend/history.
//
// `ctr`/`position` are stored as GSC returns them (ctr is clicks/impressions;
// position is the avg). siteUrl scopes by property (the GSC account also holds
// the Maine Cardworks property — mirror the gsc_monthly_summary scoping rule).
export const gscSearchMetrics = sqliteTable(
  "gsc_search_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(), // YYYY-MM-DD (GSC reporting day)
    query: text("query").notNull(),
    page: text("page").notNull(),
    clicks: integer("clicks").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    ctr: real("ctr").notNull().default(0),
    position: real("position").notNull().default(0),
    siteUrl: text("site_url").notNull().default("https://meetmeatthefair.com/"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Conflict target for the daily upsert — re-running the sync (or the
    // first-run backfill) over a date already present updates in place
    // instead of forking a duplicate metric row.
    uniqueIndex("idx_gsc_search_metrics_unique").on(t.siteUrl, t.date, t.query, t.page),
    // Trend queries are "clicks-over-time for query X" and "... for page Y".
    index("idx_gsc_search_metrics_query_date").on(t.query, t.date),
    index("idx_gsc_search_metrics_page_date").on(t.page, t.date),
    index("idx_gsc_search_metrics_date").on(t.date),
  ]
);

// A12 sibling — GA4 daily site totals. GA4 also only lives in the GA4 product
// today (src/lib/ga4.ts is all live per-request). One row per day so a single
// query returns active-users / sessions / key-events over time without a live
// Data API call. Kept deliberately coarse (site totals, not per-page) — the
// per-page/per-event breakdowns stay live.
export const ga4DailyMetrics = sqliteTable("ga4_daily_metrics", {
  date: text("date").primaryKey(), // YYYY-MM-DD; one row per day, upsert target
  activeUsers: integer("active_users").notNull().default(0),
  sessions: integer("sessions").notNull().default(0),
  keyEvents: integer("key_events").notNull().default(0),
  property: text("property").notNull().default("ga4"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// K50 (drizzle/0132, analyst 2026-06-26) — Bing daily traffic totals, the
// durable counterpart to ga4_daily_metrics so GSC + Bing search-performance are
// both queryable for trend history. Bing's GetRankAndTrafficStats returns only
// daily site totals (impressions/clicks per day) — NOT query×page like GSC — so
// this is a daily-totals sibling, not a query-grain table (the email's
// suggested "bing_search_metrics" name implied a granularity the Bing API does
// not expose). The API returns the full retained series in one call, so the
// daily sync that upserts it also backfills — no separate first-run script.
export const bingDailyMetrics = sqliteTable("bing_daily_metrics", {
  date: text("date").primaryKey(), // YYYY-MM-DD; one row per day, upsert target
  impressions: integer("impressions").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
  siteUrl: text("site_url").notNull().default("https://meetmeatthefair.com/"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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

// REL7 (2026-06-21) — per-URL last-successful-IndexNow-ping ledger. The dedup
// suppressor in pingIndexNow() reads this BEFORE the circuit breaker: a URL that
// returned 2xx from Bing within the last 24h is dropped (status='suppressed_dedup'
// in indexnow_submissions) instead of re-submitted. Root cause it fixes: both
// REL4 un-pause attempts re-tripped Bing's per-host throttle because the deferred
// queue re-pinged the SAME URLs identically on every flush. Suppression breaks
// that same-URL re-arm loop so the penalty can decay.
//
//   - url: canonical public URL (PK). One row per URL, upserted on each success.
//   - lastSuccessAt: seconds-epoch of the most recent 2xx Bing submission.
//   - contentHash: RESERVED for v2 — the "content changed → bypass suppression"
//     path. Unused/null in v1 (pure 24h suppression).
//   - updatedAt: seconds-epoch of the last write to this row.
export const indexnowUrlLastSuccess = sqliteTable("indexnow_url_last_success", {
  url: text("url").primaryKey(),
  lastSuccessAt: integer("last_success_at", { mode: "timestamp" }).notNull(),
  contentHash: text("content_hash"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Email send ledger — idempotency guard for the email-jobs queue consumer.
// Cloudflare Queues are at-least-once: a message redelivers (same `id`, higher
// `attempts`) until acked, so a send that succeeded at the provider but crashed
// before ack would re-send. The consumer records each queue message `id` here
// AFTER a successful send and skips any id already present on redelivery. Bounded
// by a per-batch prune of rows older than a few days (retries exhaust in hours).
export const emailSendLedger = sqliteTable(
  "email_send_ledger",
  {
    // The Cloudflare Queue message id — stable across redeliveries of the same message.
    messageId: text("message_id").primaryKey(),
    sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
    recipient: text("recipient"),
    source: text("source"),
    providerMessageId: text("provider_message_id"),
  },
  (table) => [index("idx_email_send_ledger_sent_at").on(table.sentAt)]
);

// K36 (2026-06-25) — CAN-SPAM suppression list. Keyed by LOWERCASE email.
// An address here has unsubscribed (or was manually suppressed/bounced) and
// MUST NOT receive solicited outbound mail (send_vendor_email, send_test_email,
// and any K41 free-form send). Transactional/system emails (receipts, approval
// notices) are exempt and do NOT consult this list — see the email subsystem
// docs. `reason`/`source` are informational for operator triage.
export const emailSuppressionList = sqliteTable(
  "email_suppression_list",
  {
    email: text("email").primaryKey(), // always stored lowercased
    reason: text("reason"), // 'unsubscribe' | 'manual' | 'bounce' | 'complaint'
    source: text("source"), // e.g. 'unsubscribe-link', 'admin'
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("idx_email_suppression_created_at").on(table.createdAt)]
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

// A9 (drizzle/0130, 2026-06-26) — edge request sampling to identify the
// recurring 21st-of-month bot inflating GA4. The zone is on the FREE plan (no
// Logpush — the only CF-native raw-UA capture, and it's Enterprise-only), so we
// sample a small slice of page requests at the middleware edge: UA + IP + ASN
// (from getCloudflareContext().cf) + path. Written fire-and-forget via
// ctx.waitUntil (never blocks the response) and pruned to ~60 days
// probabilistically. Aggregated via GET /api/admin/request-samples.
export const requestSamples = sqliteTable(
  "request_samples",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
    path: text("path"),
    method: text("method"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    asn: integer("asn"),
    asOrganization: text("as_organization"),
    country: text("country"),
    referer: text("referer"),
    ray: text("ray"),
  },
  (t) => ({
    tsIdx: index("request_samples_timestamp_idx").on(t.timestamp),
    asnIdx: index("request_samples_asn_idx").on(t.asn),
  })
);

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

// REL3 (drizzle/0116, 2026-06-08) — cursor-resume state for the daily
// recommendations-scan workflow. Single row keyed by `id='default'`; the
// workflow reads cursor at the start of each cron fire, processes N
// chunks, writes back the new cursor. Wraps to 0 + bumps completedCycles
// when the cursor reaches ALL_RULES.length. See
// mcp-server/src/workflows/recommendations-scan.ts.
export const recommendationScanState = sqliteTable("recommendation_scan_state", {
  id: text("id").primaryKey(),
  cursor: integer("cursor").notNull().default(0),
  cycleStartedAt: integer("cycle_started_at", { mode: "timestamp" }),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  lastRunChunks: integer("last_run_chunks").notNull().default(0),
  completedCycles: integer("completed_cycles").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

// A5 (drizzle/0117, 2026-06-08) — standing-failure detector debounce.
// Per-source PK; one row per error_logs.source we've alerted on. Detector
// in mcp-server/src/standing-failure-canary.ts fires when the same source
// recurs across ≥3 distinct days in a 7-day window. Per-source 7-day
// debounce — once alerted, don't re-alert until the operator either
// fixes the issue (rows stop appearing in the window) or 7 days pass.
export const standingFailureState = sqliteTable("standing_failure_state", {
  source: text("source").primaryKey(),
  lastAlertedAt: integer("last_alerted_at", { mode: "timestamp" }).notNull(),
  lastDayCount: integer("last_day_count").notNull(),
  lastTotalCount: integer("last_total_count").notNull(),
});

// OPE-15 (drizzle/0134, 2026-06-29) — debounce state for the vendor-roster
// research-queue notice. Single row, keyed by the constant NOTICE_KEY in
// mcp-server/src/roster-research-notice.ts. The notice fires after the daily
// 06:00 occurred-sweep enqueues producer-class NEEDS_RESEARCH events; this row
// holds enough to gate it to ≤1/day AND only when the backlog CHANGED since the
// last notice (don't nag on an unchanged queue). lastNoticeDate is a UTC
// YYYY-MM-DD string (matches the once-per-day comparison); lastQueueCount is the
// producer-class NEEDS_RESEARCH count at the last fire (the change-detector).
export const rosterResearchNoticeState = sqliteTable("roster_research_notice_state", {
  id: text("id").primaryKey(),
  lastNoticeDate: text("last_notice_date").notNull(),
  lastQueueCount: integer("last_queue_count").notNull(),
  lastNotifiedAt: integer("last_notified_at", { mode: "timestamp" }).notNull(),
});

// OPE-17 (drizzle/0136, 2026-06-29) — debounce state for the inbound-email
// human-triage exception-queue notice. Exact analog of rosterResearchNoticeState
// (OPE-15): single row keyed by the constant NOTICE_KEY in
// mcp-server/src/inbound-exception-notice.ts. Fires on the daily 06:00 sweep when
// the count of true salvage candidates (inbound_emails status='failed',
// resulting_event_id IS NULL, intent in new_event/submit) is non-empty AND
// changed since the last notice. lastNoticeDate is a UTC YYYY-MM-DD string.
export const inboundExceptionNoticeState = sqliteTable("inbound_exception_notice_state", {
  id: text("id").primaryKey(),
  lastNoticeDate: text("last_notice_date").notNull(),
  lastQueueCount: integer("last_queue_count").notNull(),
  lastNotifiedAt: integer("last_notified_at", { mode: "timestamp" }).notNull(),
});

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

// I1 vendor-enrichment Worker (Dev-Brief-I1, 2026-06-13). Dry-run staging for
// fill-empty-only contact fields extracted from a vendor's own website via
// Browser Rendering. Proposals land here; the live `vendors` row is untouched
// until an operator (Phase 1) or the auto-merge gate (Phase 2) approves. See
// drizzle/0123. A non-empty `flags` array marks a conflict and NEVER
// auto-merges. §6.2 domain problems reuse vendors.domain_hijacked, not a row
// here.
export const vendorEnrichmentCandidates = sqliteTable(
  "vendor_enrichment_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    vendorId: text("vendor_id").notNull(),
    // Groups one cron run's proposals for batch review. Synchronous
    // enrich_vendor calls use a 'manual-<uuid>' run id.
    jobRunId: text("job_run_id").notNull(),
    // contact_phone | contact_email | social_links | address | city | state | description
    proposedField: text("proposed_field").notNull(),
    // Vendor's value at proposal time — NULL under fill-empty-only, kept for audit.
    currentValue: text("current_value"),
    proposedValue: text("proposed_value").notNull(),
    sourceUrl: text("source_url").notNull(),
    // 'jsonld' | 'mailto' | 'tel' | 'social-link' | 'regex'
    extractionMethod: text("extraction_method").notNull(),
    // 'standard' | 'browser-rendering'
    fetchMethod: text("fetch_method"),
    confidence: real("confidence").notNull().default(0),
    // JSON array of safety-rule flag strings, e.g. ['city_mismatch'].
    flags: text("flags").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
    reviewedBy: text("reviewed_by"),
    // pending | approved | rejected | auto_merged
    decision: text("decision", {
      enum: ["pending", "approved", "rejected", "auto_merged"],
    })
      .notNull()
      .default("pending"),
  },
  (t) => [
    index("idx_vec_vendor").on(t.vendorId),
    index("idx_vec_decision").on(t.decision),
    index("idx_vec_job_run").on(t.jobRunId),
    // Partial unique: at most one OPEN proposal per (vendor, field).
    uniqueIndex("idx_vec_pending_field")
      .on(t.vendorId, t.proposedField)
      .where(sql`${t.decision} = 'pending'`),
  ]
);

// Vendor outreach attempts (analyst J1, 2026-05-29 PM). Log substrate for
// the /admin/vendor-claim-leaderboard (PR #268) outreach workflow. Once
// outcomes accumulate, the leaderboard's composite score can incorporate
// a prior_claim_outcome_signal (similar-shape vendors that claimed → boost;
// similar-shape vendors that rejected → demote). Append-only by design:
// one row per attempt; outcomes update the same row (outcome + outcome_at
// columns) when the channel produces a result. drizzle/0093.
//
// Modelled on enrichmentLog above — same append-then-update shape, same
// FK-cascade-on-vendor-delete behavior. Differs in that outcome enum is
// channel-agnostic (sent/opened/replied/claimed/rejected/no_response/
// bounced) rather than the success/failure/skipped trio.
export const vendorOutreachAttempts = sqliteTable(
  "vendor_outreach_attempts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    attemptStartedAt: integer("attempt_started_at", { mode: "timestamp" }).notNull(),
    channel: text("channel", {
      enum: ["email", "phone", "in_person", "other"],
    }).notNull(),
    // Outcome can be null on a freshly-opened attempt (operator logged
    // "I sent the email; will update when she replies"). UPDATE later
    // when the channel produces a result.
    outcome: text("outcome", {
      enum: ["sent", "opened", "replied", "claimed", "rejected", "no_response", "bounced"],
    }),
    outcomeAt: integer("outcome_at", { mode: "timestamp" }),
    notes: text("notes"),
    // user_id of the operator that logged the attempt. Nullable so MCP
    // /Cowork-driven outreach can run without a logged-in user later
    // (analyst note: outreach automation is a follow-up not in v1 scope).
    createdBy: text("created_by"),
  },
  (t) => [
    index("idx_vendor_outreach_attempts_vendor_id").on(t.vendorId),
    index("idx_vendor_outreach_attempts_started").on(t.attemptStartedAt),
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
    // UNIQUE index from drizzle/0057 — one row per (url, submission) pair.
    // Schema declaration mirrors the migration so drizzle-kit diffs stay clean.
    uniqueIndex("uq_time_to_index_log_url_submitted").on(t.url, t.indexnowSubmittedAt),
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

// A3 / K2 part 7 (drizzle/0099, analyst 2026-06-01 EVE). Daily snapshot
// rows from the MCP Worker's dedup-sweep canary. Each row records the
// cluster counts from GET /api/admin/duplicates/sweep at the time of
// the cron run. last_yellow_alerted_at tracks the 72h YELLOW debounce
// state inline (same debounce shape as the KPI YELLOW path). See
// mcp-server/src/dedup-sweep-canary.ts for the dispatch logic.
export const dedupSweepSnapshots = sqliteTable(
  "dedup_sweep_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    snapshotDate: text("snapshot_date").notNull(), // YYYY-MM-DD (UTC)
    // B — DQ1 (drizzle/0113, 2026-06-06): per-surface snapshots so one
    // table covers events + venues + promoters. Default 'events' keeps
    // legacy rows interpretable. CHECK constraint at SQL level.
    surface: text("surface", { enum: ["events", "venues", "promoters"] })
      .notNull()
      .default("events"),
    totalClusters: integer("total_clusters").notNull(),
    // Events-specific sub-breakdowns. For non-events surfaces these are
    // carried as 0 — the match shapes don't apply (venue dedup keys on
    // name+city+state; promoter dedup keys on name only).
    venueDateClusters: integer("venue_date_clusters").notNull(),
    cityStateDateClusters: integer("city_state_date_clusters").notNull(),
    // Re-purposed semantically per surface: events → events involved in
    // a cluster; venues → venues in a cluster; promoters → promoters in
    // a cluster. The shared name keeps the snapshot table single-shape.
    eventsInClusters: integer("events_in_clusters").notNull(),
    // Seconds-epoch of the most-recent YELLOW dispatch — drives the 72h
    // debounce check. NULL = never YELLOW-alerted. RED bypasses entirely.
    lastYellowAlertedAt: integer("last_yellow_alerted_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("idx_dedup_snapshot_date_surface").on(t.snapshotDate, t.surface)]
);

// Issue #326 — debounce state for the page-error Slack canary
// (mcp-server/src/page-error-canary.ts). See drizzle/0103 for the
// original rationale + drizzle/0105_page_error_canary_state_per_source.sql
// for the 2026-06-05 B2 follow-up that extended PK to (tier, source) so
// each source's bursts get their own debounce window.
export const pageErrorCanaryState = sqliteTable(
  "page_error_canary_state",
  {
    tier: text("tier").notNull(), // 'RED' | 'YELLOW'
    // Source string, e.g. 'app/events/page.tsx:getEvents'. Part of the
    // composite PK (tier, source) so a burst on getEvents alone and a
    // burst on getVenue alone alert independently.
    source: text("source").notNull(),
    lastAlertedAt: integer("last_alerted_at", { mode: "timestamp" }).notNull(),
    lastCount: integer("last_count").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tier, t.source] }),
    index("idx_page_error_canary_state_source").on(t.source),
  ]
);

// UR1 Phase 1 (drizzle/0104, 2026-06-04) — user-reported problem tracking.
// Direct response to the 6/3-6/4 outage being caught by a user not by
// monitoring (17h MTTD). Web form + email intake both write here; the
// intake hook runs the same `error_logs` burst-watch the page-error
// canary uses, escalating HIGH on co-occurrence with an active error
// burst. See drizzle/0104_problem_reports.sql for the column rationale.
export const problemReports = sqliteTable(
  "problem_reports",
  {
    id: text("id").primaryKey(),
    reporterEmail: text("reporter_email"), // null for anonymous web submissions
    body: text("body").notNull(),
    source: text("source", { enum: ["web", "email"] }).notNull(),
    path: text("path"), // page the user was on, when known
    userAgent: text("user_agent"), // captured at web intake only
    inboundEmailId: text("inbound_email_id"), // FK to inbound_emails(id); null for web
    severity: text("severity", { enum: ["LOW", "HIGH"] })
      .notNull()
      .default("LOW"),
    correlatedErrorCount: integer("correlated_error_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    resolvedByUserId: text("resolved_by_user_id"), // FK to users(id), set on resolve
    notes: text("notes"),
  },
  (t) => [
    index("idx_problem_reports_severity_resolved_created").on(
      t.severity,
      t.resolvedAt,
      t.createdAt
    ),
    index("idx_problem_reports_source").on(t.source),
  ]
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
    /** Routed intent — what the workflow actually dispatched on.
     *  Pre-classifier values: submit | correction | support | press |
     *  unsubscribe | unknown. Post-classifier additions (drizzle/0079):
     *  new_event | source_suggestion | claim_request | vendor_inquiry |
     *  spam | unclear | multi. `submit` and `new_event` route to the same
     *  workflow branch; `multi` denotes a parent of a multi-intent split. */
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
    /** ReplyKind that the send-reply step used. Distinguishes dedup
     *  hits (`already-exists`) from no-URL fallbacks, extract failures,
     *  and successful submissions. NULL on rows from before
     *  drizzle/0076. See ReplyKind union in
     *  mcp-server/src/email-handlers/types.ts for the full value list. */
    replyKind: text("reply_kind"),
    /** Event this inbound resolved against. Dual-purpose:
     *  - `reply_kind = 'ok'` → the NEW event we created
     *  - `reply_kind = 'already-exists'` → the EXISTING event matched
     *  NULL when no event is involved (no-url, extract-failed, etc.). */
    resultingEventId: text("resulting_event_id"),
    /** Idempotency marker for the "your submission was salvaged" admin-
     *  triggered notification (Item 19 / drizzle/0091). Set by
     *  src/lib/salvage-notification.ts after the EMAIL_JOBS push so
     *  re-running the salvage admin action doesn't double-email the
     *  submitter. NULL = never salvaged (or sweep failed before reaching
     *  the marker). Mirrors events.approval_notified_at semantics. */
    salvageNotifiedAt: integer("salvage_notified_at", { mode: "timestamp" }),
    /** Which fetch path produced the URL content:
     *  - `'standard'`           — default fetch with browser UA succeeded
     *  - `'browser-rendering'`  — standard fetch failed (403/4xx/timeout),
     *                             Cloudflare Browser Rendering REST API
     *                             succeeded as fallback. Added drizzle/0078.
     *  - `'failed'`             — both paths failed; row has status='failed'
     *  NULL on pre-A5 rows. */
    fetchMethod: text("fetch_method"),
    /** Which extraction strategy produced the event:
     *  - `'json-ld'`   — Event-schema JSON-LD on the page was complete enough
     *                     to populate ExtractedEventData directly; Workers AI
     *                     was NOT called for this row. Added drizzle/0083.
     *  - `'ai'`        — Workers AI Llama 3.1 8B extracted from page prose.
     *  - `'free-text'` — No URL in the email; AI extracted directly from body
     *                     text. Reserved for the free-text branch.
     *  - `'mixed'`     — Partial JSON-LD + AI top-up. Reserved.
     *  NULL on rows from before PR-B shipped. */
    extractionMethod: text("extraction_method"),
    // ----- Phase C.1 classifier columns (drizzle/0079) -----
    /** LLM-predicted intent from the 9-value taxonomy. NULL on pre-
     *  classifier rows OR when the entrypoint took the trusted_fastpath. */
    classifiedIntent: text("classified_intent"),
    /** Sub-intent for new_event only: single_url | multi_url | free_text |
     *  attachment_only | mixed. NULL for non-new_event intents. */
    classifiedSubIntent: text("classified_sub_intent"),
    /** Classifier's 0.0–1.0 confidence. Compared against the
     *  CLASSIFIER_CONFIDENCE_THRESHOLD env var (default 0.85). */
    classifiedConfidence: real("classified_confidence"),
    /** One-sentence rationale string from the LLM. Surfaced in admin UI
     *  for low-confidence rows. */
    classifiedRationale: text("classified_rationale"),
    /** When the classifier ran. May lag received_at if the classifier
     *  moved into the workflow step due to entrypoint budget pressure. */
    classifiedAt: integer("classified_at", { mode: "timestamp" }),
    /** Prompt + model fingerprint (e.g. `c-2026-05-20-v1`). Lets the
     *  D.1 dashboard track accuracy by version + A/B prompt revisions. */
    classifierVersion: text("classifier_version"),
    /** How the row was routed: 'classifier' | 'classifier_override' |
     *  'fallback_low_confidence' | 'trusted_fastpath' | 'address_only'. */
    routingSource: text("routing_source"),
    /** Workflow ID the row dispatched to. Useful for multi-intent split
     *  rows where each child has its own workflow. */
    routedToWorkflow: text("routed_to_workflow"),
    /** Admin-queue surfacing flag: set when confidence < threshold, when
     *  a multi-intent split fell back, or when admin manually flagged
     *  via the D.1 UI. */
    flaggedForReview: integer("flagged_for_review").notNull().default(0),
    /** Multi-intent split linkage. NULL on normal + parent rows; for
     *  child rows, points to the parent's id (which has intent='multi'). */
    parentEmailId: text("parent_email_id"),
    /** Number of times the stale-sweep has recreated this row's workflow.
     *  Sweep increments on each Pattern-B recreate; after MAX_RECOVERY_ATTEMPTS
     *  (3) the sweep marks the row terminally failed with
     *  reply_kind='sweep-exceeded' instead of recreating — caps the
     *  infinite-loop scenario the existing sweep docblock warns about
     *  (root-caused 2026-05-19 hamxposition.org NonRetryableError loop).
     *  Added drizzle/0082. */
    recoveryAttemptN: integer("recovery_attempt_n").notNull().default(0),
    /** Categorical failure reason for submit-intent rows whose AI extract
     *  was reached but didn't yield a usable event. Values:
     *    - `'zero-events'`  — AI returned success with empty events[]
     *    - `'thin-content'` — content sent to AI was <500 chars after strip
     *    - `'parse-error'`  — AI response wasn't parseable JSON
     *    - `'ai-timeout'`   — Workers AI didn't respond within budget
     *    - `'other'`        — anything else; check the `error` column
     *  NULL on success and on rows that never reached AI extract
     *  (json-ld bypass, no-url early return, fetch failure).
     *  Added drizzle/0094 — analyst K7 Tier 1, 2026-05-31. */
    extractFailReason: text("extract_fail_reason"),
    /** First 16 hex chars of SHA-256 of the content fed to AI extraction.
     *  Cheap cluster key so /admin/source-quality can identify pages that
     *  consistently fail (same hash, repeated failures). NULL on pre-K7
     *  rows + on paths that don't fetch HTML. Added drizzle/0094. */
    contentSha256First16: text("content_sha256_first16"),
    /** Length in chars of content fed to AI extraction. Lets dashboards
     *  separate thin-content failures (page returned <2KB of usable text)
     *  from rich-content extract failures (the AI just couldn't parse the
     *  layout). NULL on pre-K7 rows. Added drizzle/0094. */
    contentLengthChars: integer("content_length_chars"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_inbound_emails_received_at").on(t.receivedAt),
    index("idx_inbound_emails_intent").on(t.intent),
    index("idx_inbound_emails_status").on(t.status),
    index("idx_inbound_emails_from").on(t.fromAddress),
    // Partial index supporting "which content hashes consistently fail"
    // queries on /admin/source-quality. Most inbound rows have NULL hash
    // so the partial keeps the index small. Added drizzle/0094.
    index("idx_inbound_emails_content_hash")
      .on(t.contentSha256First16)
      .where(sql`${t.contentSha256First16} IS NOT NULL`),
    // Partial-unique on message_id (NULLs are exempt — SQLite already
    // treats them as distinct, but spelled explicitly via WHERE for
    // clarity). Added 0073 for inbound idempotency.
    uniqueIndex("uq_inbound_emails_message_id")
      .on(t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
    // Partial index on reply_kind for "show only dedup hits" filters.
    // Added drizzle/0076.
    index("idx_inbound_emails_reply_kind")
      .on(t.replyKind)
      .where(sql`${t.replyKind} IS NOT NULL`),
    // Multi-intent child lookup. Added drizzle/0079.
    index("idx_inbound_emails_parent")
      .on(t.parentEmailId)
      .where(sql`${t.parentEmailId} IS NOT NULL`),
    // D.1 dashboard group-by. Added drizzle/0079.
    index("idx_inbound_emails_classified_intent")
      .on(t.classifiedIntent)
      .where(sql`${t.classifiedIntent} IS NOT NULL`),
    // Admin queue filter. Added drizzle/0079.
    index("idx_inbound_emails_flagged")
      .on(t.flaggedForReview)
      .where(sql`${t.flaggedForReview} = 1`),
    // Accuracy-by-version queries. Added drizzle/0079.
    index("idx_inbound_emails_classifier_version")
      .on(t.classifierVersion)
      .where(sql`${t.classifierVersion} IS NOT NULL`),
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
export type RecommendationScanState = typeof recommendationScanState.$inferSelect;
export type StandingFailureState = typeof standingFailureState.$inferSelect;
export type EnrichmentLog = typeof enrichmentLog.$inferSelect;
export type VendorEnrichmentCandidate = typeof vendorEnrichmentCandidates.$inferSelect;
export type NewVendorEnrichmentCandidate = typeof vendorEnrichmentCandidates.$inferInsert;
export type TimeToIndexLog = typeof timeToIndexLog.$inferSelect;
export type CompetitorDomain = typeof competitorDomains.$inferSelect;
export type InboundEmail = typeof inboundEmails.$inferSelect;

// Registry of source domains suggested via inbound email. Backs the
// 3-tier source_suggestion handler in mcp-server (spec §C.8 /
// drizzle/0084). Sender emails us pointing at a website as an events
// source → Tier 1 (this table) or Tier 2 (informal events.source_url
// match) or Tier 3 (INSERT new pending_review row).
//
// **Naming history**: originally called `discovery_candidates` in PR-D
// (drizzle/0084), but that name collided with a pre-existing prod table
// of the same name owned by a separate harvest-rules feature. Renamed
// to `email_source_suggestions` in PR-F before any prod migration was
// applied, so no rename-data-migration is needed — drizzle/0084 was
// modified in place to create the renamed table.
export const emailSourceSuggestions = sqliteTable(
  "email_source_suggestions",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    /** Lowercased hostname stripped of `www.` prefix, e.g. "mainemade.com".
     *  Primary lookup key for Tier 1 ("do we already pull from this?"). */
    host: text("host").notNull(),
    /** pending_review (default) | active | rejected. */
    status: text("status").notNull().default("pending_review"),
    /** Email of the sender who first suggested it. Denormalized from the
     *  inbound row for cheap admin queries. */
    suggestedByEmail: text("suggested_by_email"),
    /** FK-style link back to inbound_emails.id. NULL if entered manually. */
    suggestedViaInboundId: text("suggested_via_inbound_id"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
    reviewedByUserId: text("reviewed_by_user_id"),
    adminNotes: text("admin_notes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_email_source_suggestions_host").on(t.host),
    index("idx_email_source_suggestions_status").on(t.status),
    // One pending suggestion per host — multiple senders flagging the
    // same domain pile into one row instead of spawning a duplicate queue.
    uniqueIndex("uq_email_source_suggestions_pending_host")
      .on(t.host)
      .where(sql`status = 'pending_review'`),
  ]
);

export type EmailSourceSuggestion = typeof emailSourceSuggestions.$inferSelect;

// Pre-existing prod table — owned by the daily NE event discovery skill
// that lives outside this repo. Schema captured from `PRAGMA
// table_info(discovery_candidates)` on 2026-05-21 prod D1 (24 rows). No
// migration here: this Drizzle entry just types our writes into the
// table from the email-source-suggestions approval endpoint. The
// harvest skill is the canonical owner; we're acting as a producer that
// promotes approved suggestions into the harvest queue (PR-T closes
// the C.8 loop the spec §C.8 originally intended). Don't add columns or
// indices from this side — coordinate with the harvest-skill owner first.
export const discoveryCandidates = sqliteTable("discovery_candidates", {
  id: text("id").primaryKey(),
  /** Which discovery rule produced this candidate. Existing values:
   *  aggregator_probe, jsonapi_harvest, phase_b_daily_search,
   *  simpleview_sitemap_harvest, tec_events_api_harvest,
   *  year_rollover_missing, maker_fest_2026_verification. Email
   *  promotions use 'email_suggestion'. */
  ruleSlug: text("rule_slug").notNull(),
  /** Source taxonomy. Existing values: aggregator, event_page, probe,
   *  web_search, year_rollover. Email promotions use 'aggregator' since
   *  the suggested URL is typically an events-calendar / listing page. */
  sourceType: text("source_type").notNull(),
  /** Display label for the source. Email promotions use the hostname. */
  sourceLabel: text("source_label").notNull(),
  sourceUrl: text("source_url"),
  sourceRefId: text("source_ref_id"),
  state: text("state"),
  category: text("category"),
  expectedYield: integer("expected_yield"),
  lastYield: integer("last_yield"),
  totalEventsCreated: integer("total_events_created").notNull().default(0),
  cmsType: text("cms_type"),
  harvestMethod: text("harvest_method"),
  harvestEndpoint: text("harvest_endpoint"),
  rescrapeIntervalDays: integer("rescrape_interval_days"),
  /** pending (default) | snoozed | skipped | needs_followup | resolved.
   *  Email promotions land at 'pending' for the harvest skill to triage. */
  status: text("status").notNull().default("pending"),
  statusReason: text("status_reason"),
  lastOutcome: text("last_outcome"),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  lastHarvestedAt: integer("last_harvested_at", { mode: "timestamp" }),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  snoozedUntil: integer("snoozed_until", { mode: "timestamp" }),
});

export type DiscoveryCandidate = typeof discoveryCandidates.$inferSelect;

// B4: single-use tokens backing the pre-filled correction form sent in
// MEDIUM/LOW confidence email replies. See drizzle/0085. Sender clicks
// link in reply email → GET /submit-event/<token> renders edit form
// pre-filled with event fields → POST corrects the event + marks used.
// 30-day expiry; one-time use.
export const submissionCorrectionTokens = sqliteTable(
  "submission_correction_tokens",
  {
    token: text("token").primaryKey(),
    eventId: text("event_id").notNull(),
    /** Inbound email that produced this token. Useful for the admin UI
     *  to backlink "this event was corrected via inbound 2f5f0c74". */
    inboundEmailId: text("inbound_email_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_submission_correction_tokens_event").on(t.eventId),
    index("idx_submission_correction_tokens_expires")
      .on(t.expiresAt)
      .where(sql`used_at IS NULL`),
  ]
);

export type SubmissionCorrectionToken = typeof submissionCorrectionTokens.$inferSelect;

// Operator-set trust annotation for email senders. Read-side surfaces on
// /admin/inbound-emails sender summary panel; write via the
// set_email_sender_trust MCP tool. trust_status values: unknown (default),
// trusted, watchlist, blocked. See drizzle/0075 for status semantics.
export const inboundEmailSenders = sqliteTable(
  "inbound_email_senders",
  {
    email: text("email").primaryKey(),
    trustStatus: text("trust_status").notNull().default("unknown"),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("idx_inbound_senders_trust").on(t.trustStatus)]
);

export type InboundEmailSender = typeof inboundEmailSenders.$inferSelect;

// Phase D.1 (drizzle/0080): ground-truth feedback for classifier
// decisions. Captures admin reclassifications, workflow-outcome
// inference, sender click-through (Phase D.3), and active labeling.
// Same shape will be reused for future AI-decision feedback (extraction,
// JSON-LD, etc.) per spec §D.4.3.
export const inboundEmailIntentFeedback = sqliteTable(
  "inbound_email_intent_feedback",
  {
    id: text("id").primaryKey(),
    inboundEmailId: text("inbound_email_id").notNull(),
    /** admin_reroute | admin_label | workflow_outcome | sender_feedback
     *  | user_reply. See drizzle/0080 for semantics. */
    feedbackSource: text("feedback_source").notNull(),
    /** What the classifier picked. NULL for retroactive labels on pre-
     *  classifier rows. */
    originalIntent: text("original_intent"),
    /** Ground-truth value per the feedback_source. */
    correctedIntent: text("corrected_intent").notNull(),
    /** Stamps which classifier_version produced original_intent. */
    classifierVersion: text("classifier_version"),
    adminNote: text("admin_note"),
    /** Admin user_id when admin-sourced; NULL otherwise. */
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_intent_feedback_email").on(t.inboundEmailId),
    index("idx_intent_feedback_source").on(t.feedbackSource),
    index("idx_intent_feedback_version")
      .on(t.classifierVersion)
      .where(sql`${t.classifierVersion} IS NOT NULL`),
    index("idx_intent_feedback_created").on(t.createdAt),
  ]
);

export type InboundEmailIntentFeedback = typeof inboundEmailIntentFeedback.$inferSelect;

// Phase D.3 (drizzle/0081): signed-token lifecycle for sender feedback
// widgets. Random 32-byte token stored as PK; one-time-use enforced by
// used_at marker; 60-day expiry. Mirrors src/lib/vendor-claim-token.ts
// pattern.
export const inboundEmailFeedbackTokens = sqliteTable(
  "inbound_email_feedback_tokens",
  {
    token: text("token").primaryKey(),
    inboundEmailId: text("inbound_email_id").notNull(),
    /** 'receipt' | 'approval' | 'other' */
    feedbackMoment: text("feedback_moment").notNull(),
    resultingEventId: text("resulting_event_id"),
    issuedAt: integer("issued_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
  },
  (t) => [
    index("idx_feedback_tokens_email").on(t.inboundEmailId),
    index("idx_feedback_tokens_event")
      .on(t.resultingEventId)
      .where(sql`${t.resultingEventId} IS NOT NULL`),
    index("idx_feedback_tokens_expires").on(t.expiresAt),
  ]
);

export type InboundEmailFeedbackToken = typeof inboundEmailFeedbackTokens.$inferSelect;

// Phase D.3 (drizzle/0081): sender feedback events. One row per click
// (or per follow-up form submission). feedback_token is UNIQUE so the
// dataset never double-counts.
export const inboundEmailSenderFeedback = sqliteTable(
  "inbound_email_sender_feedback",
  {
    id: text("id").primaryKey(),
    inboundEmailId: text("inbound_email_id").notNull(),
    feedbackToken: text("feedback_token").notNull().unique(),
    /** 'receipt' | 'approval' | 'other' */
    feedbackMoment: text("feedback_moment").notNull(),
    /** 'correct' | 'wrong_intent' | 'needs_fixing' | 'cancel' | 'looks_good' */
    feedbackValue: text("feedback_value").notNull(),
    intendedIntent: text("intended_intent"),
    freeText: text("free_text"),
    resultingEventId: text("resulting_event_id"),
    submittedAt: integer("submitted_at", { mode: "timestamp" }).notNull(),
    submitterIp: text("submitter_ip"),
    submitterUserAgent: text("submitter_user_agent"),
  },
  (t) => [
    index("idx_sender_feedback_email").on(t.inboundEmailId),
    index("idx_sender_feedback_moment").on(t.feedbackMoment, t.feedbackValue),
  ]
);

export type InboundEmailSenderFeedback = typeof inboundEmailSenderFeedback.$inferSelect;

// ─────────────────────────────────────────────────────────────────
// GW1 — Goodwill Engine Phase 1 (drizzle/0101, 2026-06-02)
//
// Four tables backing cross-source discrepancy capture + per-source
// reliability scoring. Phase 1 ends at "ranked outreach queue"; Phase
// 2 (the outreach communication layer) is explicitly out of scope —
// `event_discrepancies.outreach_id` is reserved NULL in Phase 1 so
// Phase 2 adds behavior without a migration.
//
// See drizzle/0101_event_discrepancies.sql for the SQL + seed priors
// header explaining the design.
// ─────────────────────────────────────────────────────────────────

export const eventDiscrepancies = sqliteTable("event_discrepancies", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  /** date | hours | venue | status | price | existence | name */
  fieldClass: text("field_class", {
    enum: ["date", "hours", "venue", "status", "price", "existence", "name"],
  }).notNull(),
  /** The value MMATF currently treats as correct (events column value
   *  at capture time). NULL when the field is absent. */
  authoritativeValue: text("authoritative_value"),
  /** Aligns with events.source_domain (lowercased, no www). */
  authoritativeSourceKey: text("authoritative_source_key"),
  authoritativeSourceUrl: text("authoritative_source_url"),
  /** What the other source claims. For self_consistency rows, the
   *  "what the field should be if the inconsistency were corrected" hint. */
  divergentValue: text("divergent_value"),
  divergentSourceKey: text("divergent_source_key"),
  divergentSourceUrl: text("divergent_source_url"),
  /** ingest_addverify | stale_page_radar | self_consistency | holdout_sample
   *  | manual.
   *  Phase 2/3 will add: crowd_report, ai_monitor.
   *
   *  holdout_sample added GW1.3 (2026-06-03) — daily random sample of
   *  high-trust source events re-checked against the live source page.
   *  No CHECK constraint in the DDL so the addition is TS-only. */
  detectedBy: text("detected_by", {
    enum: ["ingest_addverify", "stale_page_radar", "self_consistency", "holdout_sample", "manual"],
  }).notNull(),
  /** Epoch seconds — `mode: "timestamp"` convention. */
  detectedAt: integer("detected_at", { mode: "timestamp" }).notNull(),
  /** 0..1 detector confidence. NULL when capture path doesn't compute it. */
  confidence: real("confidence"),
  /** open | resolved_authoritative | resolved_divergent | self_resolved | dismissed */
  resolutionStatus: text("resolution_status", {
    enum: ["open", "resolved_authoritative", "resolved_divergent", "self_resolved", "dismissed"],
  })
    .notNull()
    .default("open"),
  resolvedValue: text("resolved_value"),
  /** higher_tier | post_event | operator. Phase 2 will add promoter_reply. */
  resolutionSource: text("resolution_source", {
    enum: ["higher_tier", "post_event", "operator"],
  }),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  /** Computed by GW1d queue ranker. Boolean-as-integer. */
  outreachCandidate: integer("outreach_candidate", { mode: "boolean" }).notNull().default(false),
  outreachPriorityScore: real("outreach_priority_score"),
  /** Phase 2 placeholder — always NULL in Phase 1 per B13. Reserving
   *  the column now means the Phase 2 wiring is a no-migration change. */
  outreachId: text("outreach_id"),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type EventDiscrepancy = typeof eventDiscrepancies.$inferSelect;

export const sourceReliability = sqliteTable(
  "source_reliability",
  {
    sourceKey: text("source_key").notNull(),
    fieldClass: text("field_class", {
      enum: ["date", "hours", "venue", "status", "price", "existence", "name"],
    }).notNull(),
    /** accuracy | freshness */
    axis: text("axis", { enum: ["accuracy", "freshness"] }).notNull(),
    /** Snapshot of the source's type at row creation; denormalized so
     *  the scoring path doesn't JOIN sources on every read. */
    priorType: text("prior_type").notNull(),
    /** Beta distribution params: successes + prior, failures + prior. */
    alpha: real("alpha").notNull(),
    beta: real("beta").notNull(),
    nChecks: integer("n_checks").notNull().default(0),
    nAgreed: integer("n_agreed").notNull().default(0),
    nStale: integer("n_stale").notNull().default(0),
    /** Posterior mean alpha/(alpha+beta). Denormalized for queue-rank
     *  sort without recomputing per read. */
    score: real("score").notNull(),
    /** prior_only | low | established */
    confidence: text("confidence", {
      enum: ["prior_only", "low", "established"],
    }).notNull(),
    /** Bumps when seed-priors change so old rows can be distinguished
     *  from rows scored under the new prior set. */
    modelVersion: text("model_version").notNull(),
    lastUpdated: integer("last_updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceKey, t.fieldClass, t.axis] })]
);

export type SourceReliability = typeof sourceReliability.$inferSelect;

// G remainder (Dev backlog 2026-06-05): single-row config table for
// the GW1.2 flip margin (and future GW1.x thresholds — GW1.4's
// authority-override margin sits here too per the 2026-06-03 spec).
// CHECK(id=1) enforces single-row semantics. getFlipMargin(db) in
// src/lib/goodwill/get-flip-margin.ts reads this row with the
// hardcoded RELIABILITY_FLIP_MARGIN as a memoized fallback.
export const goodwillConfig = sqliteTable("goodwill_config", {
  id: integer("id").primaryKey(),
  flipMargin: real("flip_margin").notNull().default(0.2),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type GoodwillConfig = typeof goodwillConfig.$inferSelect;

export const sources = sqliteTable("sources", {
  sourceKey: text("source_key").primaryKey(),
  displayName: text("display_name").notNull(),
  /** official | dmo_tourism | ticketing | newspaper | social | aggregator | community | unknown */
  sourceType: text("source_type", {
    enum: [
      "official",
      "dmo_tourism",
      "ticketing",
      "newspaper",
      "social",
      "aggregator",
      "community",
      "unknown",
    ],
  }).notNull(),
  /** Tiebreaker in the GW1d reliability-weighted resolution path when
   *  two sources have equal posterior scores. */
  authorityWeight: real("authority_weight").notNull().default(1.0),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Source = typeof sources.$inferSelect;

export const sourceTypePriors = sqliteTable(
  "source_type_priors",
  {
    sourceType: text("source_type").notNull(),
    fieldClass: text("field_class").notNull(),
    axis: text("axis").notNull(),
    priorAlpha: real("prior_alpha").notNull(),
    priorBeta: real("prior_beta").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceType, t.fieldClass, t.axis] })]
);

export type SourceTypePrior = typeof sourceTypePriors.$inferSelect;

// GW1e (drizzle/0102, 2026-06-02). Daily snapshot of the goodwill-
// queue health + per-tier reliability medians. Backs the Slack
// canary in mcp-server/src/goodwill/health-canary.ts and the report-
// card admin tool. Mirrors the dedup_sweep_snapshots shape from 0099.
export const goodwillHealthSnapshots = sqliteTable("goodwill_health_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(), // YYYY-MM-DD UTC
  openCount: integer("open_count").notNull(),
  outreachCandidateCount: integer("outreach_candidate_count").notNull(),
  weightedPrioritySum: real("weighted_priority_sum").notNull(),
  openIngestAddverify: integer("open_ingest_addverify").notNull().default(0),
  openStalePageRadar: integer("open_stale_page_radar").notNull().default(0),
  openSelfConsistency: integer("open_self_consistency").notNull().default(0),
  openManual: integer("open_manual").notNull().default(0),
  resolvedLast28d: integer("resolved_last_28d").notNull().default(0),
  dismissedLast28d: integer("dismissed_last_28d").notNull().default(0),
  medianOfficialFreshness: real("median_official_freshness"),
  medianOfficialAccuracy: real("median_official_accuracy"),
  medianAggregatorAccuracy: real("median_aggregator_accuracy"),
  /** 72h debounce state for YELLOW alerts. NULL = never alerted. */
  lastYellowAlertedAt: integer("last_yellow_alerted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type GoodwillHealthSnapshot = typeof goodwillHealthSnapshots.$inferSelect;

// ─── SYN1 — Push-on-change syndication (drizzle/0122) ────────────────────────
// Generic, vendor-agnostic mirror-correction propagation. Any mutation to a
// venue/event/event_day writes an outbox row in the SAME db.batch() as the
// entity UPDATE (so a correction is never dropped), then a queue dispatcher
// (MCP Worker) fans out signed webhooks to registered subscribers. Emitter
// holds ZERO subscriber-specific code — adding a subscriber is an INSERT.

// Durable change-log. One row per mirror-affecting mutation. Self-contained:
// `snapshot` carries the entity's full mirrored payload at change time.
export const syndicationOutbox = sqliteTable(
  "syndication_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // 'venue' | 'event' | 'event_day' — the mutated entity.
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    // Monotonic per (entity_type, entity_id) — audit/ordering within one
    // entity's stream. Set via a MAX(change_version)+1 subquery inside the
    // batch. NOTE: this is NOT the delivery version — consumers dedup on the
    // per-event `events.syndication_version` (see buildEventSnapshot).
    changeVersion: integer("change_version").notNull(),
    // JSON array of changed mirrored field names.
    changedFields: text("changed_fields").notNull().default("[]"),
    // JSON object — the entity's mirrored payload at the time of change.
    snapshot: text("snapshot").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    // NULL until the dispatcher acks a successful fan-out. Drives the
    // "unprocessed backlog" canary + lets a redeploy resume cleanly.
    processedAt: integer("processed_at", { mode: "timestamp" }),
  },
  (t) => ({
    entityIdx: index("idx_syndication_outbox_entity").on(t.entityType, t.entityId),
    processedIdx: index("idx_syndication_outbox_processed").on(t.processedAt),
  })
);

// Registered consumers. One row per subscriber; the signing secret lives here
// (once), not per subscription, so onboarding is a single INSERT.
export const syndicationSubscribers = sqliteTable("syndication_subscribers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(), // human label, e.g. "maine-cardworks"
  callbackUrl: text("callback_url").notNull(),
  // Per-subscriber HMAC-SHA256 secret. Stored in D1 (not a Worker secret) so
  // adding/rotating a subscriber needs no deploy.
  signingSecret: text("signing_secret").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Which event IDs a subscriber tracks. Notification grain is per-event because
// consumers key on event_id, not venue_id.
export const syndicationSubscriptions = sqliteTable(
  "syndication_subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subscriberId: text("subscriber_id")
      .notNull()
      .references(() => syndicationSubscribers.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    uniqueSubEvent: uniqueIndex("uq_syndication_sub_event").on(t.subscriberId, t.eventId),
    eventIdx: index("idx_syndication_subscriptions_event").on(t.eventId),
  })
);

export type SyndicationOutboxRow = typeof syndicationOutbox.$inferSelect;
export type SyndicationSubscriber = typeof syndicationSubscribers.$inferSelect;
export type SyndicationSubscription = typeof syndicationSubscriptions.$inferSelect;

// ─── SYN1 — Drizzle statement builders (shared by all 5 write-paths) ─────────
// These embed into a `db.batch([...])` alongside the entity UPDATE so the
// outbox row + version bump commit atomically with the correction. The *pure*
// gate + snapshot policy lives in `@takemetothefair/utils` (syndication-outbox).

/**
 * SQL expression computing the next monotonic `change_version` for one entity's
 * outbox stream: `MAX(change_version) + 1` scoped to (entity_type, entity_id),
 * defaulting to 1 for the first row. Safe inside a `db.batch()` — D1 runs batch
 * statements sequentially in one implicit transaction.
 */
export function syndicationOutboxChangeVersionExpr(entityType: string, entityId: string) {
  return sql<number>`(SELECT COALESCE(MAX(${syndicationOutbox.changeVersion}), 0) + 1 FROM ${syndicationOutbox} WHERE ${syndicationOutbox.entityType} = ${entityType} AND ${syndicationOutbox.entityId} = ${entityId})`;
}

/**
 * Build the `values()` payload for a `syndication_outbox` INSERT. `id` and
 * `createdAt` use the column `$defaultFn`s; `processedAt` defaults to NULL.
 * `snapshot`/`changedFields` are JSON-stringified here so call sites pass plain
 * objects/arrays.
 */
export function buildSyndicationOutboxValues(input: {
  entityType: "venue" | "event" | "event_day";
  entityId: string;
  changedFields: readonly string[];
  snapshot: unknown;
}) {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    changeVersion: syndicationOutboxChangeVersionExpr(input.entityType, input.entityId),
    changedFields: JSON.stringify(input.changedFields),
    snapshot: JSON.stringify(input.snapshot),
  };
}

/**
 * SQL expression for `.set({ syndicationVersion: eventSyndicationVersionBumpExpr() })`
 * — increments the per-event delivery counter in place.
 */
export function eventSyndicationVersionBumpExpr() {
  return sql`${events.syndicationVersion} + 1`;
}
