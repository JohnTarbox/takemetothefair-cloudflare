import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

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
    slug: text("slug").notNull().unique(),
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
  slug: text("slug").notNull().unique(),
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
    slug: text("slug").notNull().unique(),
    description: text("description"),
    promoterId: text("promoter_id")
      .notNull()
      .references(() => promoters.id, { onDelete: "cascade" }),
    venueId: text("venue_id").references(() => venues.id, { onDelete: "set null" }),
    startDate: integer("start_date", { mode: "timestamp" }),
    endDate: integer("end_date", { mode: "timestamp" }),
    datesConfirmed: integer("dates_confirmed", { mode: "boolean" }).default(true),
    recurrenceRule: text("recurrence_rule"),
    categories: text("categories").default("[]"),
    tags: text("tags").default("[]"),
    ticketUrl: text("ticket_url"),
    ticketPriceMin: real("ticket_price_min"),
    ticketPriceMax: real("ticket_price_max"),
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
    // Vendor decision-support fields
    vendorFeeMin: real("vendor_fee_min"),
    vendorFeeMax: real("vendor_fee_max"),
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
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_events_status_startdate").on(table.status, table.startDate),
    index("idx_events_venueid").on(table.venueId),
    index("idx_events_promoterid").on(table.promoterId),
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
  slug: text("slug").notNull().unique(),
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
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

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
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_eventvendors_eventid_status").on(table.eventId, table.status),
    index("idx_eventvendors_vendorid").on(table.vendorId),
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
  schemaPriceMin: real("schema_price_min"),
  schemaPriceMax: real("schema_price_max"),
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
    slug: text("slug").notNull().unique(),
    body: text("body").notNull(), // Markdown content
    excerpt: text("excerpt"),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tags: text("tags").default("[]"),
    categories: text("categories").default("[]"),
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

// Analytics Events table — server-side event tracking
export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventName: text("event_name").notNull(),
    eventCategory: text("event_category").notNull(),
    timestamp: integer("timestamp").notNull(),
    properties: text("properties").default("{}"),
    userId: text("user_id"),
    source: text("source"),
  },
  (table) => [
    index("idx_analytics_events_name_ts").on(table.eventName, table.timestamp),
    index("idx_analytics_events_category_ts").on(table.eventCategory, table.timestamp),
  ]
);

// Error Logs table
export const errorLogs = sqliteTable("error_logs", {
  id: text("id").primaryKey(),
  timestamp: integer("timestamp").notNull(),
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
