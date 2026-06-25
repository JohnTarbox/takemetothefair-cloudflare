/**
 * Zod validation schemas — canonical home for input validation used by both
 * the main app's API routes and (where shapes overlap) the MCP server's
 * tool input definitions.
 */

import { z } from "zod";
import {
  EVENT_STATUS,
  EVENT_LIFECYCLE_VALUES,
  VENUE_STATUS,
  EVENT_VENDOR_STATUS,
  PAYMENT_STATUS,
  PARTICIPATION_TYPE,
  BLOG_POST_STATUS,
  INDOOR_OUTDOOR,
  EVENT_SCALE,
} from "@takemetothefair/constants";
import { sanitizeProse, decodeHtmlEntities, coerceVenueNameAtIngest } from "@takemetothefair/utils";
import { parseDateOnly } from "@takemetothefair/datetime";

/** Length and format limits used across input validators. App-only
 *  business limits (pagination, dedup thresholds) live in
 *  src/lib/constants.ts; these are validation-layer concerns. */
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

// Common field schemas
const nameSchema = z
  .string()
  .min(VALIDATION.NAME_MIN_LENGTH)
  .max(VALIDATION.NAME_MAX_LENGTH)
  .transform(sanitizeProse);
const descriptionSchema = z
  .string()
  .max(VALIDATION.DESCRIPTION_MAX_LENGTH)
  .transform(sanitizeProse)
  .optional()
  .nullable();
const urlSchema = z
  .string()
  .url()
  .max(VALIDATION.URL_MAX_LENGTH)
  .optional()
  .nullable()
  .or(z.literal(""));
const emailSchema = z
  .string()
  .email()
  .max(VALIDATION.EMAIL_MAX_LENGTH)
  .optional()
  .nullable()
  .or(z.literal(""));
const phoneSchema = z.string().max(VALIDATION.PHONE_MAX_LENGTH).optional().nullable();

// Venue schemas.
//
// The base object schema is `_venueCreateBaseSchema` (NOT exported) — used
// directly to derive `venueUpdateSchema` via `.partial()` (admins editing
// an existing venue must be able to set any field freely, including a
// name that would have tripped the DQ2 ingest guard).
//
// `venueCreateSchema` wraps the base in a `.transform()` that applies the
// DQ2 coercion (address-as-name → derive name from city/state, copy
// offending string into `address` if address was empty). The transform
// only runs on CREATE, so callers correcting an existing row aren't
// second-guessed.
const _venueCreateBaseSchema = z.object({
  name: nameSchema,
  address: z.string().min(1).max(VALIDATION.ADDRESS_MAX_LENGTH),
  city: z.string().min(1).max(VALIDATION.CITY_MAX_LENGTH),
  state: z.string().min(1).max(VALIDATION.STATE_MAX_LENGTH),
  zip: z.string().min(1).max(VALIDATION.ZIP_MAX_LENGTH),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  capacity: z.number().int().positive().optional().nullable(),
  amenities: z.array(z.string()).optional().default([]),
  // IMG1 §1b Phase 1 — per-image focal point (0–1). Applies to image_url.
  imageFocalX: z.number().min(0).max(1).optional().default(0.5),
  imageFocalY: z.number().min(0).max(1).optional().default(0.5),
  contactEmail: emailSchema,
  contactPhone: phoneSchema,
  website: urlSchema,
  description: descriptionSchema,
  imageUrl: urlSchema,
  googlePlaceId: z.string().optional().nullable(),
  googleMapsUrl: urlSchema,
  openingHours: z.string().optional().nullable(),
  googleRating: z.number().min(0).max(5).optional().nullable(),
  googleRatingCount: z.number().int().min(0).optional().nullable(),
  googleTypes: z.string().optional().nullable(),
  accessibility: z.string().optional().nullable(),
  parking: z.string().optional().nullable(),
  status: z
    .enum([VENUE_STATUS.ACTIVE, VENUE_STATUS.INACTIVE])
    .optional()
    .default(VENUE_STATUS.ACTIVE),
});

export const venueCreateSchema = _venueCreateBaseSchema.transform((v) => {
  const coerced = coerceVenueNameAtIngest({
    name: v.name,
    address: v.address,
    city: v.city,
    state: v.state,
  });
  return coerced.wasCoerced ? { ...v, name: coerced.name, address: coerced.address } : v;
});

// Update keeps every field optional and skips the DQ2 transform — admins
// editing an existing venue should not be second-guessed about its name.
export const venueUpdateSchema = _venueCreateBaseSchema.partial();

// Promoter schemas
export const promoterCreateSchema = z.object({
  userId: z.string().uuid().optional().nullable(),
  companyName: nameSchema,
  description: descriptionSchema,
  website: urlSchema,
  socialLinks: z.string().optional().nullable(), // JSON string
  logoUrl: urlSchema,
  verified: z.boolean().optional().default(false),
  // IMG1 §1b Phase 1 — per-image focal point (0–1). Applies to logo_url.
  imageFocalX: z.number().min(0).max(1).optional().default(0.5),
  imageFocalY: z.number().min(0).max(1).optional().default(0.5),
});

export const promoterUpdateSchema = promoterCreateSchema.partial().omit({ userId: true });

// Vendor schemas
export const vendorCreateSchema = z.object({
  userId: z.string().uuid(),
  businessName: nameSchema,
  description: descriptionSchema,
  vendorType: z.string().max(100).optional().nullable(),
  products: z.array(z.string()).optional().default([]),
  website: urlSchema,
  socialLinks: z.string().optional().nullable(), // JSON string
  logoUrl: urlSchema,
  verified: z.boolean().optional().default(false),
  commercial: z.boolean().optional().default(false),
  // IMG1 §1b Phase 1 — per-image focal point (0–1). Applies to logo_url.
  imageFocalX: z.number().min(0).max(1).optional().default(0.5),
  imageFocalY: z.number().min(0).max(1).optional().default(0.5),
  canSelfConfirm: z.boolean().optional().default(false),
  // Contact Information
  contactName: z.string().max(VALIDATION.NAME_MAX_LENGTH).optional().nullable(),
  contactEmail: emailSchema,
  contactPhone: phoneSchema,
  // Physical Address
  address: z.string().max(VALIDATION.ADDRESS_MAX_LENGTH).optional().nullable(),
  city: z.string().max(VALIDATION.CITY_MAX_LENGTH).optional().nullable(),
  state: z.string().max(VALIDATION.STATE_MAX_LENGTH).optional().nullable(),
  zip: z.string().max(VALIDATION.ZIP_MAX_LENGTH).optional().nullable(),
  // Geolocation
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  // Business Details
  // Upper bound evaluated per-validation via .refine() rather than
  // .max(getFullYear()), which would freeze the cap to whatever year
  // it was when the module first loaded. In Cloudflare Workers cold
  // starts this can lock to 1970 (epoch) if module init runs before
  // the isolate has performed any I/O, producing a confusing
  // "expected to be <= 1970" error from a 2026 form submit.
  yearEstablished: z
    .number()
    .int()
    .min(1800)
    .optional()
    .nullable()
    .refine((v) => v == null || v <= new Date().getFullYear(), {
      message: "Year established cannot be in the future",
    }),
  paymentMethods: z.array(z.string()).optional().default([]),
  licenseInfo: z.string().max(500).optional().nullable(),
  insuranceInfo: z.string().max(500).optional().nullable(),
});

export const vendorUpdateSchema = vendorCreateSchema
  .partial()
  .omit({ userId: true })
  .extend({
    // Enhanced Profile (round-3) — most callers should go through the
    // Enhanced Profile admin panel which posts these via PATCH. The MCP
    // server has its own set_enhanced_profile tool that's preferred for
    // activation/expiry; this PATCH path is for piecemeal field edits.
    enhanced_profile: z.boolean().optional(),
    enhanced_profile_expires_at: z.string().datetime().optional(),
    gallery_images: z
      .array(
        z.object({
          url: z.string().url().max(VALIDATION.URL_MAX_LENGTH),
          alt: z.string().max(200),
          caption: z.string().max(500).optional(),
        })
      )
      .max(2)
      .optional(),
    slug: z
      .string()
      .min(1)
      .max(VALIDATION.SLUG_MAX_LENGTH)
      .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens only")
      .optional(),
    featured_priority: z.number().int().min(0).optional(),
    // Claimed tier (drizzle/0049). Admin sets true to mark vendor as
    // self-confirmed-owner; sets false to revoke. claimed_at and
    // claimed_by are derived server-side from the transition + actor.
    claimed: z.boolean().optional(),
    // Verified Pro tier scaffold (drizzle/0052). Admin-only set; no vendor
    // email per business decision. Orthogonal to claimed.
    verified_pro: z.boolean().optional(),
    // EH1 Phase 1 (drizzle/0106 + 0107). The vendor hierarchy + relationship
    // model. Admin-only by virtue of this schema being the admin PATCH
    // surface. Vendor self-edit (vendorProfileUpdateSchema below) exposes
    // ONLY display_mode and only for LOCAL_OFFICE roles, so the
    // parent-controlled gate (`display_override_permitted`) stays admin-side.
    // See src/lib/vendor-hierarchy.ts for the resolution rule and
    // Dev-Spec-Vendor-Hierarchy-Phase1-2026-06-04.md for the design.
    role: z.enum(["NATIONAL", "LOCAL_OFFICE", "INDEPENDENT"]).optional(),
    brand_parent_vendor_id: z.string().min(1).nullable().optional(),
    operator_parent_vendor_id: z.string().min(1).nullable().optional(),
    alias_of_vendor_id: z.string().min(1).nullable().optional(),
    relationship_type: z
      .enum([
        "branch",
        "franchise",
        "dealer",
        "member",
        "agent",
        "employee_branch",
        "government",
        "independent",
      ])
      .optional(),
    default_child_display: z.enum(["self", "brand_parent", "both"]).nullable().optional(),
    display_override_permitted: z.boolean().optional(),
    display_mode: z
      .enum(["inherit", "self", "brand_parent", "operator_parent", "both"])
      .nullable()
      .optional(),
    // A5 — admin can also set the public display-name alias (snake_case here to
    // match this schema's admin-PATCH convention; mapped to vendors.displayName
    // in the route). Send null to clear → revert to business_name.
    display_name: z
      .string()
      .min(VALIDATION.NAME_MIN_LENGTH)
      .max(VALIDATION.NAME_MAX_LENGTH)
      .transform(sanitizeProse)
      .nullable()
      .optional(),
  });

// delete_vendor (MCP tool / DELETE /api/admin/vendors/[id]) — soft-delete
// with optional 301 redirect to a canonical replacement. Hard delete (mode
// = "hard") is reserved for the purge sweep + force=true cases. See doc
// memo for refuse-conditions and side-effects.
export const vendorDeleteSchema = z.object({
  mode: z.enum(["soft", "hard"]).optional().default("soft"),
  redirect_to_vendor_id: z.string().uuid().optional().nullable(),
  rewrite_blog_links: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  // Required when force=true. Min 10 chars to discourage one-word excuses
  // ("spam") that lose context for future audit review.
  reason: z.string().min(10).max(500).optional(),
});

// Event Day schema (per-day schedule)
//
// DQ4 (2026-06-08): openTime/closeTime are now optional + nullable. The
// shape mirrors drizzle/0118's NOT NULL → NULL relaxation. Callers that
// previously supplied "" or omitted the field hit a Zod failure; now both
// "" (coerced to null via the transform) and absent are accepted, and the
// downstream ingest paths treat null as "hours unknown" and set the
// owning event's flagged_for_review=1 for operator triage.
export const eventDaySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format")
    .refine((s) => parseDateOnly(s) !== null, "Invalid calendar date (e.g. Feb 30, month 13)"),
  openTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Time must be HH:MM format")
    .optional()
    .nullable()
    .transform((v) => (v === "" || v == null ? null : v)),
  closeTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Time must be HH:MM format")
    .optional()
    .nullable()
    .transform((v) => (v === "" || v == null ? null : v)),
  notes: z.string().max(200).optional().nullable(),
  closed: z.boolean().optional().default(false),
  vendorOnly: z.boolean().optional().default(false),
});

// Event schemas - base fields
const eventBaseSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  promoterId: z.string().min(1),
  venueId: z.string().min(1).optional().nullable(),
  stateCode: z.string().length(2).optional().nullable(),
  isStatewide: z.boolean().optional().default(false),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  datesConfirmed: z.boolean().optional().default(true),
  discontinuousDates: z.boolean().optional().default(false),
  recurrenceRule: z.string().optional().nullable(),
  categories: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  ticketUrl: urlSchema,
  ticketPriceMin: z.number().min(0).optional().nullable(),
  ticketPriceMax: z.number().min(0).optional().nullable(),
  imageUrl: urlSchema,
  // IMG1 §1b Phase 1 (2026-06-08) — per-image focal-point (0–1 fraction
  // of image dimensions). Default 0.5/0.5 = center; flows through cards
  // and (in future) any crop-on-hero rendering as Cloudflare's gravity=XxY.
  // Clamped here at the schema boundary; cdnImage()'s focalPointGravity
  // helper also clamps + short-circuits the (0.5, 0.5) default.
  imageFocalX: z.number().min(0).max(1).optional().default(0.5),
  imageFocalY: z.number().min(0).max(1).optional().default(0.5),
  featured: z.boolean().optional().default(false),
  commercialVendorsAllowed: z.boolean().optional().default(true),
  // Vendor decision-support fields
  vendorFeeMin: z.number().min(0).optional().nullable(),
  vendorFeeMax: z.number().min(0).optional().nullable(),
  vendorFeeNotes: z.string().max(500).optional().nullable(),
  indoorOutdoor: z
    .enum([INDOOR_OUTDOOR.INDOOR, INDOOR_OUTDOOR.OUTDOOR, INDOOR_OUTDOOR.MIXED])
    .optional()
    .nullable(),
  estimatedAttendance: z.number().int().positive().optional().nullable(),
  eventScale: z
    .enum([EVENT_SCALE.SMALL, EVENT_SCALE.MEDIUM, EVENT_SCALE.LARGE, EVENT_SCALE.MAJOR])
    .optional()
    .nullable(),
  applicationDeadline: z.string().datetime().optional().nullable(),
  applicationUrl: z.string().url().max(VALIDATION.URL_MAX_LENGTH).optional().nullable(),
  applicationInstructions: z.string().max(2000).optional().nullable(),
  walkInsAllowed: z.boolean().optional().nullable(),
  status: z
    .enum([
      EVENT_STATUS.DRAFT,
      EVENT_STATUS.PENDING,
      EVENT_STATUS.TENTATIVE,
      EVENT_STATUS.APPROVED,
      EVENT_STATUS.REJECTED,
      EVENT_STATUS.CANCELLED,
    ])
    .optional()
    .default(EVENT_STATUS.DRAFT),
  sourceName: z.string().optional().nullable(),
  sourceUrl: urlSchema,
  sourceId: z.string().optional().nullable(),
  syncEnabled: z.boolean().optional(),
  eventDays: z
    .array(eventDaySchema)
    .max(100, "Maximum 100 days allowed for daily schedules")
    .optional(),
});

// Event create schema with cross-field validation
export const eventCreateSchema = eventBaseSchema
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.endDate) >= new Date(data.startDate);
      }
      return true;
    },
    {
      message: "End date must be on or after start date",
      path: ["endDate"],
    }
  )
  .refine(
    (data) => {
      if (data.ticketPriceMin != null && data.ticketPriceMax != null) {
        return data.ticketPriceMax >= data.ticketPriceMin;
      }
      return true;
    },
    {
      message: "Maximum ticket price must be greater than or equal to minimum price",
      path: ["ticketPriceMax"],
    }
  )
  .refine(
    (data) => {
      if (data.vendorFeeMin != null && data.vendorFeeMax != null) {
        return data.vendorFeeMax >= data.vendorFeeMin;
      }
      return true;
    },
    {
      message: "Maximum vendor fee must be greater than or equal to minimum fee",
      path: ["vendorFeeMax"],
    }
  )
  .refine(
    (data) => {
      if (data.discontinuousDates) {
        return data.eventDays && data.eventDays.length >= 1;
      }
      return true;
    },
    {
      message: "Discontinuous date events must have at least one date",
      path: ["eventDays"],
    }
  )
  .refine(
    (data) => {
      // When no venue is attached, stateCode is how the event gets placed on
      // /events/<state> listings. Enforce on create only — updates may touch
      // venueId without revisiting stateCode.
      if (!data.venueId && !data.stateCode) return false;
      return true;
    },
    {
      message: "State is required when no venue is selected",
      path: ["stateCode"],
    }
  );

export const eventUpdateSchema = eventBaseSchema
  .partial()
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.endDate) >= new Date(data.startDate);
      }
      return true;
    },
    {
      message: "End date must be on or after start date",
      path: ["endDate"],
    }
  )
  .refine(
    (data) => {
      if (data.ticketPriceMin != null && data.ticketPriceMax != null) {
        return data.ticketPriceMax >= data.ticketPriceMin;
      }
      return true;
    },
    {
      message: "Maximum ticket price must be greater than or equal to minimum price",
      path: ["ticketPriceMax"],
    }
  )
  .refine(
    (data) => {
      if (data.vendorFeeMin != null && data.vendorFeeMax != null) {
        return data.vendorFeeMax >= data.vendorFeeMin;
      }
      return true;
    },
    {
      message: "Maximum vendor fee must be greater than or equal to minimum fee",
      path: ["vendorFeeMax"],
    }
  );

// Event vendor status enum (shared across schemas)
const eventVendorStatusEnum = z.enum([
  EVENT_VENDOR_STATUS.INVITED,
  EVENT_VENDOR_STATUS.INTERESTED,
  EVENT_VENDOR_STATUS.APPLIED,
  EVENT_VENDOR_STATUS.WAITLISTED,
  EVENT_VENDOR_STATUS.APPROVED,
  EVENT_VENDOR_STATUS.CONFIRMED,
  EVENT_VENDOR_STATUS.REJECTED,
  EVENT_VENDOR_STATUS.WITHDRAWN,
  EVENT_VENDOR_STATUS.CANCELLED,
]);

const paymentStatusEnum = z.enum([
  PAYMENT_STATUS.NOT_REQUIRED,
  PAYMENT_STATUS.PENDING,
  PAYMENT_STATUS.PAID,
  PAYMENT_STATUS.REFUNDED,
  PAYMENT_STATUS.OVERDUE,
]);

// Participation mode (drizzle/0071, 2026-05-16). Orthogonal to status.
const participationTypeEnum = z.enum([
  PARTICIPATION_TYPE.EXHIBITOR,
  PARTICIPATION_TYPE.SPONSOR_ONLY,
  PARTICIPATION_TYPE.SPONSOR_AND_EXHIBITOR,
]);

// Event vendor schemas
//
// F — K18 Phase 1 (2026-06-06): all three schemas accept an optional
// `eventDayId` to scope the link to a specific occurrence of a recurring
// event. Omitted / null → series-wide (preserves pre-K18 behavior).
// Backward-compatible: existing callers that don't pass eventDayId
// continue to produce series-wide links exactly as before.
export const eventVendorCreateSchema = z.object({
  eventId: z.string().uuid(),
  vendorId: z.string().uuid(),
  boothInfo: z.string().max(500).optional().nullable(),
  status: eventVendorStatusEnum.optional().default(EVENT_VENDOR_STATUS.APPLIED),
  paymentStatus: paymentStatusEnum.optional().default(PAYMENT_STATUS.NOT_REQUIRED),
  participationType: participationTypeEnum.optional().default(PARTICIPATION_TYPE.EXHIBITOR),
  eventDayId: z.string().uuid().optional().nullable(),
});

// Schema for adding vendor to event (eventId comes from URL params)
export const eventVendorAddSchema = z.object({
  vendorId: z.string().uuid(),
  boothInfo: z.string().max(500).optional().nullable(),
  status: eventVendorStatusEnum.optional().default(EVENT_VENDOR_STATUS.CONFIRMED),
  paymentStatus: paymentStatusEnum.optional().default(PAYMENT_STATUS.NOT_REQUIRED),
  participationType: participationTypeEnum.optional().default(PARTICIPATION_TYPE.EXHIBITOR),
  eventDayId: z.string().uuid().optional().nullable(),
});

export const eventVendorUpdateSchema = z.object({
  eventVendorId: z.string().uuid(),
  boothInfo: z.string().max(500).optional().nullable(),
  status: eventVendorStatusEnum.optional(),
  paymentStatus: paymentStatusEnum.optional(),
  participationType: participationTypeEnum.optional(),
  // PATCH can move a link from series-wide to per-day (or vice versa, or
  // between dates). Use `null` to explicitly clear an existing eventDayId.
  // Omit the field entirely to leave it unchanged.
  eventDayId: z.string().uuid().optional().nullable(),
});

// User schemas
export const userUpdateSchema = z.object({
  name: z.string().max(VALIDATION.NAME_MAX_LENGTH).optional().nullable(),
  email: z.string().email().max(VALIDATION.EMAIL_MAX_LENGTH).optional(),
  role: z.enum(["ADMIN", "PROMOTER", "VENDOR", "USER"]).optional(),
});

// Vendor profile update (self-service)
export const vendorProfileUpdateSchema = z.object({
  businessName: nameSchema.optional(),
  description: descriptionSchema,
  vendorType: z.string().max(100).optional().nullable(),
  products: z.array(z.string()).optional(),
  website: urlSchema,
  logoUrl: urlSchema,
  contactName: z.string().max(VALIDATION.NAME_MAX_LENGTH).optional().nullable(),
  contactEmail: emailSchema,
  contactPhone: phoneSchema,
  address: z.string().max(VALIDATION.ADDRESS_MAX_LENGTH).optional().nullable(),
  city: z.string().max(VALIDATION.CITY_MAX_LENGTH).optional().nullable(),
  state: z.string().max(VALIDATION.STATE_MAX_LENGTH).optional().nullable(),
  zip: z.string().max(VALIDATION.ZIP_MAX_LENGTH).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  // Upper bound evaluated per-validation via .refine() rather than
  // .max(getFullYear()), which would freeze the cap to whatever year
  // it was when the module first loaded. In Cloudflare Workers cold
  // starts this can lock to 1970 (epoch) if module init runs before
  // the isolate has performed any I/O, producing a confusing
  // "expected to be <= 1970" error from a 2026 form submit.
  yearEstablished: z
    .number()
    .int()
    .min(1800)
    .optional()
    .nullable()
    .refine((v) => v == null || v <= new Date().getFullYear(), {
      message: "Year established cannot be in the future",
    }),
  paymentMethods: z.array(z.string()).optional(),
  licenseInfo: z.string().max(500).optional().nullable(),
  insuranceInfo: z.string().max(500).optional().nullable(),
  // EH1 Phase 1 — the ONLY hierarchy field a claimed LOCAL_OFFICE can
  // self-edit. Setting this expresses a *preference*; whether it's
  // honored at render time still depends on the parent's
  // `display_override_permitted` gate (only admin or the brand-parent
  // owner can flip that). The other hierarchy columns (role,
  // brand_parent_vendor_id, operator_parent_vendor_id, alias_of_vendor_id,
  // relationship_type, default_child_display, display_override_permitted)
  // are intentionally absent from this schema — they're admin-only via
  // vendorUpdateSchema and the three admin MCP tools
  // (set_vendor_relationship, set_vendor_display_policy, set_vendor_alias).
  // Route handler also gates on vendor.role: non-LOCAL_OFFICE vendors get
  // 400 if they try to set this.
  displayMode: z
    .enum(["inherit", "self", "brand_parent", "operator_parent", "both"])
    .nullable()
    .optional(),
  // A5 (Dev-Email-2026-06-10 §A) — a claimed vendor may set a public display
  // name distinct from its legal business_name; the render layer resolves
  // COALESCE(display_name, business_name) (see displayVendorName /
  // vendorSelfDisplayName in @takemetothefair/utils). Unlike displayMode this
  // is NOT hierarchy-gated — it's a benign alias on the owner's own row. Send
  // null to clear and revert to business_name. (.min/.max BEFORE .transform per
  // CLAUDE.md — decoding only shortens, so the raw cap is a safe upper bound.)
  displayName: z
    .string()
    .min(VALIDATION.NAME_MIN_LENGTH)
    .max(VALIDATION.NAME_MAX_LENGTH)
    .transform(sanitizeProse)
    .nullable()
    .optional(),
});

// Promoter event creation
export const promoterEventCreateSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
    venueId: z.string().min(1).optional().nullable(),
    stateCode: z.string().length(2).optional().nullable(),
    isStatewide: z.boolean().optional().default(false),
    startDate: z.string().datetime().optional().nullable(),
    endDate: z.string().datetime().optional().nullable(),
    discontinuousDates: z.boolean().optional().default(false),
    categories: z.array(z.string()).optional().default([]),
    tags: z.array(z.string()).optional().default([]),
    ticketUrl: urlSchema,
    ticketPriceMin: z.number().min(0).optional().nullable(),
    ticketPriceMax: z.number().min(0).optional().nullable(),
    imageUrl: urlSchema,
    eventDays: z
      .array(eventDaySchema)
      .max(100, "Maximum 100 days allowed for daily schedules")
      .optional(),
    // Vendor decision-support fields
    vendorFeeMin: z.number().min(0).optional().nullable(),
    vendorFeeMax: z.number().min(0).optional().nullable(),
    vendorFeeNotes: z.string().max(500).optional().nullable(),
    indoorOutdoor: z
      .enum([INDOOR_OUTDOOR.INDOOR, INDOOR_OUTDOOR.OUTDOOR, INDOOR_OUTDOOR.MIXED])
      .optional()
      .nullable(),
    estimatedAttendance: z.number().int().positive().optional().nullable(),
    eventScale: z
      .enum([EVENT_SCALE.SMALL, EVENT_SCALE.MEDIUM, EVENT_SCALE.LARGE, EVENT_SCALE.MAJOR])
      .optional()
      .nullable(),
    applicationDeadline: z.string().datetime().optional().nullable(),
    applicationUrl: z.string().url().max(VALIDATION.URL_MAX_LENGTH).optional().nullable(),
    applicationInstructions: z.string().max(2000).optional().nullable(),
    walkInsAllowed: z.boolean().optional().nullable(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.endDate) >= new Date(data.startDate);
      }
      return true;
    },
    {
      message: "End date must be on or after start date",
      path: ["endDate"],
    }
  )
  .refine(
    (data) => {
      if (data.ticketPriceMin != null && data.ticketPriceMax != null) {
        return data.ticketPriceMax >= data.ticketPriceMin;
      }
      return true;
    },
    {
      message: "Maximum ticket price must be greater than or equal to minimum price",
      path: ["ticketPriceMax"],
    }
  )
  .refine(
    (data) => {
      if (data.vendorFeeMin != null && data.vendorFeeMax != null) {
        return data.vendorFeeMax >= data.vendorFeeMin;
      }
      return true;
    },
    {
      message: "Maximum vendor fee must be greater than or equal to minimum fee",
      path: ["vendorFeeMax"],
    }
  )
  .refine(
    (data) => {
      if (data.discontinuousDates) {
        return data.eventDays && data.eventDays.length >= 1;
      }
      return true;
    },
    {
      message: "Discontinuous date events must have at least one date",
      path: ["eventDays"],
    }
  )
  .refine(
    (data) => {
      if (!data.venueId && !data.stateCode) return false;
      return true;
    },
    {
      message: "State is required when no venue is selected",
      path: ["stateCode"],
    }
  );

// User profile update
export const userProfileUpdateSchema = z.object({
  name: z.string().max(VALIDATION.NAME_MAX_LENGTH).optional().nullable(),
});

// Favorite toggle
export const favoriteSchema = z.object({
  type: z.enum(["EVENT", "VENUE", "VENDOR", "PROMOTER"]),
  id: z.string().min(1),
});

// FAQ item shape for blog posts. Decoded at the boundary so JSON-LD,
// schema validators, and dedup all see literal characters (e.g. agents
// posting `&amp;` round-trip to `&`). Matches src/lib/event-faq.ts:FaqItem.
const blogFaqItemSchema = z.object({
  question: z.string().min(1).max(500).transform(decodeHtmlEntities),
  answer: z.string().min(1).max(5000).transform(decodeHtmlEntities),
});

// Blog post schemas
export const blogPostCreateSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1), // Markdown content
  excerpt: z.string().max(500).optional().nullable(),
  authorId: z.string().min(1).optional(), // Optional — defaults to session user
  tags: z.array(z.string()).optional().default([]),
  categories: z.array(z.string()).optional().default([]),
  faqs: z.array(blogFaqItemSchema).optional().default([]),
  featuredImageUrl: urlSchema,
  // F1 (drizzle/0119, 2026-06-08) — focal point for the featured image.
  // Drives the gravity arg BlogPostCard uses so the editor's "place the
  // dot" gesture survives card crops at every responsive width. Optional
  // and validated 0.0–1.0; omitted → backend default 0.5/0.5 (= center,
  // which short-circuits to the gravity-omitted URL via focalPointGravity()
  // so the pre-F1 derivative cache key is preserved).
  imageFocalX: z.number().min(0).max(1).optional(),
  imageFocalY: z.number().min(0).max(1).optional(),
  status: z
    .enum([BLOG_POST_STATUS.DRAFT, BLOG_POST_STATUS.PUBLISHED])
    .optional()
    .default(BLOG_POST_STATUS.DRAFT),
  publishDate: z.string().datetime().optional().nullable(),
  metaTitle: z.string().max(70).optional().nullable(),
  metaDescription: z.string().max(160).optional().nullable(),
  // Homepage ranking (drizzle/0128, 2026-06-23) — editorial pin. Fed to the
  // weighted scorer as a strong boost (src/lib/blog/homepage-ranking.ts), not a
  // hard override. Omitted → backend default false.
  featured: z.boolean().optional(),
});

export const blogPostUpdateSchema = blogPostCreateSchema
  .partial()
  .omit({ authorId: true })
  .extend({
    // Override fields that have .default() on the create schema — partial() doesn't
    // remove defaults, so omitted fields would get filled with default values on update.
    tags: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    faqs: z.array(blogFaqItemSchema).optional(),
    status: z.enum([BLOG_POST_STATUS.DRAFT, BLOG_POST_STATUS.PUBLISHED]).optional(),
    // K43 / A3.1 — escape hatch for the publish-time broken-link gate. When a
    // PUBLISHED save introduces an internal /events,/vendors,/venues,/blog link
    // that doesn't resolve, the PUT is rejected 422 unless this is true. Lets a
    // deliberate forward-reference (cluster guide published before its pillar)
    // through while still blocking accidental dead links. Not persisted.
    allowBrokenLinks: z.boolean().optional(),
  });

// ── Event lifecycle update ───────────────────────────────────────
//
// Used by /api/admin/events/[id]/lifecycle PATCH and the MCP
// `update_event_lifecycle` tool. Validation-layer only — transition
// legality is enforced server-side via validateLifecycleTransition().

export const eventLifecycleUpdateSchema = z
  .object({
    new_lifecycle: z.enum(EVENT_LIFECYCLE_VALUES as [string, ...string[]]),
    reason: z.string().min(1).max(500).transform(decodeHtmlEntities).optional().nullable(),
    new_start_date: z.string().datetime().optional().nullable(),
    new_end_date: z.string().datetime().optional().nullable(),
  })
  .refine(
    (d) => {
      // For RESCHEDULED, new dates are required. POSTPONED may pass null
      // dates (we don't know the new dates yet) — that's valid. Other
      // transitions ignore date fields.
      if (d.new_lifecycle === "RESCHEDULED") {
        return d.new_start_date != null && d.new_end_date != null;
      }
      return true;
    },
    {
      message: "RESCHEDULED transition requires new_start_date and new_end_date",
      path: ["new_start_date"],
    }
  )
  .refine(
    (d) => {
      if (d.new_start_date && d.new_end_date) {
        return new Date(d.new_end_date) >= new Date(d.new_start_date);
      }
      return true;
    },
    {
      message: "new_end_date must be on or after new_start_date",
      path: ["new_end_date"],
    }
  );

export type EventLifecycleUpdate = z.infer<typeof eventLifecycleUpdateSchema>;

// Helper function to validate and parse request body
export async function validateRequestBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<
  { success: true; data: z.infer<T> } | { success: false; error: string; issues: z.ZodIssue[] }
> {
  try {
    const body = await request.json();
    const result = schema.safeParse(body);

    if (!result.success) {
      return {
        success: false,
        error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
        issues: result.error.issues,
      };
    }

    return { success: true, data: result.data };
  } catch {
    return {
      success: false,
      error: "Invalid JSON body",
      issues: [],
    };
  }
}
