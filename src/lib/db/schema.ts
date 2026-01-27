import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

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
  status: text("status", { enum: ["ACTIVE", "INACTIVE"] }).default("ACTIVE").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Promoters table
export const promoters = sqliteTable("promoters", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
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
  venueId: text("venue_id").notNull().references(() => venues.id),
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
  status: text("status", { enum: ["DRAFT", "PENDING", "APPROVED", "REJECTED", "CANCELLED"] }).default("DRAFT").notNull(),
  viewCount: integer("view_count").default(0),
  // External source tracking for synced events
  sourceName: text("source_name"), // e.g., "mainefairs.net"
  sourceUrl: text("source_url"), // URL of the event on the source site
  sourceId: text("source_id"), // Unique identifier from the source (e.g., slug or ID)
  syncEnabled: integer("sync_enabled", { mode: "boolean" }).default(true),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
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
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Event Vendors junction table
export const eventVendors = sqliteTable("event_vendors", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  vendorId: text("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  boothInfo: text("booth_info"),
  status: text("status", { enum: ["PENDING", "APPROVED", "REJECTED"] }).default("PENDING").notNull(),
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

// Notifications table
export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: integer("read", { mode: "boolean" }).default(false),
  data: text("data"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// NextAuth tables
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionToken: text("session_token").notNull().unique(),
  expires: integer("expires", { mode: "timestamp" }).notNull(),
});

export const verificationTokens = sqliteTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: integer("expires", { mode: "timestamp" }).notNull(),
});

// Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  promoter: one(promoters, { fields: [users.id], references: [promoters.userId] }),
  vendor: one(vendors, { fields: [users.id], references: [vendors.userId] }),
  favorites: many(userFavorites),
  notifications: many(notifications),
  accounts: many(accounts),
  sessions: many(sessions),
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

// Type exports
export type User = typeof users.$inferSelect;
export type Venue = typeof venues.$inferSelect;
export type Promoter = typeof promoters.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type EventVendor = typeof eventVendors.$inferSelect;
export type UserFavorite = typeof userFavorites.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
