/**
 * Database schema — copied from main app's src/lib/db/schema.ts.
 * KEEP IN SYNC: changes to the main schema must be reflected here.
 */
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// Users table
export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  name: text("name"),
  role: text("role", { enum: ["ADMIN", "PROMOTER", "VENDOR", "USER"] }).default("USER").notNull(),
  emailVerified: integer("email_verified", { mode: "timestamp" }),
  image: text("image"),
  oauthProvider: text("oauth_provider"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Venues table
export const venues = sqliteTable("venues", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
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
  status: text("status", { enum: ["ACTIVE", "INACTIVE"] }).default("ACTIVE").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Promoters table
export const promoters = sqliteTable("promoters", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").unique().references(() => users.id, { onDelete: "set null" }),
  companyName: text("company_name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  website: text("website"),
  socialLinks: text("social_links"),
  logoUrl: text("logo_url"),
  verified: integer("verified", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Events table
export const events = sqliteTable("events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  promoterId: text("promoter_id").notNull().references(() => promoters.id, { onDelete: "cascade" }),
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
  commercialVendorsAllowed: integer("commercial_vendors_allowed", { mode: "boolean" }).default(true),
  status: text("status", { enum: ["DRAFT", "PENDING", "TENTATIVE", "APPROVED", "REJECTED", "CANCELLED"] }).default("DRAFT").notNull(),
  viewCount: integer("view_count").default(0),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  sourceId: text("source_id"),
  syncEnabled: integer("sync_enabled", { mode: "boolean" }).default(true),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  discontinuousDates: integer("discontinuous_dates", { mode: "boolean" }).default(false),
  suggesterEmail: text("suggester_email"),
  submittedByUserId: text("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Vendors table
export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
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
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  yearEstablished: integer("year_established"),
  paymentMethods: text("payment_methods").default("[]"),
  licenseInfo: text("license_info"),
  insuranceInfo: text("insurance_info"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Event Vendors junction table
export const eventVendors = sqliteTable("event_vendors", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  vendorId: text("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  boothInfo: text("booth_info"),
  status: text("status", { enum: ["INVITED", "INTERESTED", "APPLIED", "WAITLISTED", "APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"] }).default("APPLIED").notNull(),
  paymentStatus: text("payment_status", { enum: ["NOT_REQUIRED", "PENDING", "PAID", "REFUNDED", "OVERDUE"] }).default("NOT_REQUIRED").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Event Days table
export const eventDays = sqliteTable("event_days", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  openTime: text("open_time").notNull(),
  closeTime: text("close_time").notNull(),
  notes: text("notes"),
  closed: integer("closed", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// User Favorites table
export const userFavorites = sqliteTable("user_favorites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  favoritableType: text("favoritable_type", { enum: ["EVENT", "VENUE", "VENDOR", "PROMOTER"] }).notNull(),
  favoritableId: text("favoritable_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// API Tokens table
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  name: text("name").notNull().default("Default"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});
