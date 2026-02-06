/**
 * Zod validation schemas for API routes
 */

import { z } from "zod";
import { VALIDATION, EVENT_STATUS, VENUE_STATUS, EVENT_VENDOR_STATUS } from "@/lib/constants";

// Common field schemas
const nameSchema = z.string().min(VALIDATION.NAME_MIN_LENGTH).max(VALIDATION.NAME_MAX_LENGTH);
const descriptionSchema = z.string().max(VALIDATION.DESCRIPTION_MAX_LENGTH).optional().nullable();
const urlSchema = z.string().url().max(VALIDATION.URL_MAX_LENGTH).optional().nullable();
const emailSchema = z.string().email().max(VALIDATION.EMAIL_MAX_LENGTH).optional().nullable();
const phoneSchema = z.string().max(VALIDATION.PHONE_MAX_LENGTH).optional().nullable();

// Venue schemas
export const venueCreateSchema = z.object({
  name: nameSchema,
  address: z.string().min(1).max(VALIDATION.ADDRESS_MAX_LENGTH),
  city: z.string().min(1).max(VALIDATION.CITY_MAX_LENGTH),
  state: z.string().min(1).max(VALIDATION.STATE_MAX_LENGTH),
  zip: z.string().min(1).max(VALIDATION.ZIP_MAX_LENGTH),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  capacity: z.number().int().positive().optional().nullable(),
  amenities: z.array(z.string()).optional().default([]),
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
  status: z.enum([VENUE_STATUS.ACTIVE, VENUE_STATUS.INACTIVE]).optional().default(VENUE_STATUS.ACTIVE),
});

export const venueUpdateSchema = venueCreateSchema.partial();

// Promoter schemas
export const promoterCreateSchema = z.object({
  userId: z.string().uuid().optional().nullable(),
  companyName: nameSchema,
  description: descriptionSchema,
  website: urlSchema,
  socialLinks: z.string().optional().nullable(), // JSON string
  logoUrl: urlSchema,
  verified: z.boolean().optional().default(false),
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
  // Contact Information
  contactName: z.string().max(VALIDATION.NAME_MAX_LENGTH).optional().nullable(),
  contactEmail: emailSchema,
  contactPhone: phoneSchema,
  // Physical Address
  address: z.string().max(VALIDATION.ADDRESS_MAX_LENGTH).optional().nullable(),
  city: z.string().max(VALIDATION.CITY_MAX_LENGTH).optional().nullable(),
  state: z.string().max(VALIDATION.STATE_MAX_LENGTH).optional().nullable(),
  zip: z.string().max(VALIDATION.ZIP_MAX_LENGTH).optional().nullable(),
  // Business Details
  yearEstablished: z.number().int().min(1800).max(new Date().getFullYear()).optional().nullable(),
  paymentMethods: z.array(z.string()).optional().default([]),
  licenseInfo: z.string().max(500).optional().nullable(),
  insuranceInfo: z.string().max(500).optional().nullable(),
});

export const vendorUpdateSchema = vendorCreateSchema.partial().omit({ userId: true });

// Event Day schema (per-day schedule)
export const eventDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
  openTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM format"),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM format"),
  notes: z.string().max(200).optional().nullable(),
  closed: z.boolean().optional().default(false),
});

// Event schemas - base fields
const eventBaseSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  promoterId: z.string().min(1),
  venueId: z.string().min(1).optional().nullable(),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  datesConfirmed: z.boolean().optional().default(true),
  recurrenceRule: z.string().optional().nullable(),
  categories: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  ticketUrl: urlSchema,
  ticketPriceMin: z.number().min(0).optional().nullable(),
  ticketPriceMax: z.number().min(0).optional().nullable(),
  imageUrl: urlSchema,
  featured: z.boolean().optional().default(false),
  commercialVendorsAllowed: z.boolean().optional().default(true),
  status: z.enum([
    EVENT_STATUS.DRAFT,
    EVENT_STATUS.PENDING,
    EVENT_STATUS.APPROVED,
    EVENT_STATUS.REJECTED,
    EVENT_STATUS.CANCELLED,
  ]).optional().default(EVENT_STATUS.DRAFT),
  sourceName: z.string().optional().nullable(),
  sourceUrl: urlSchema,
  sourceId: z.string().optional().nullable(),
  eventDays: z.array(eventDaySchema).max(100, "Maximum 100 days allowed for daily schedules").optional(),
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
  );

export const eventUpdateSchema = eventBaseSchema.partial()
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
  );

// Event vendor schemas
export const eventVendorCreateSchema = z.object({
  eventId: z.string().uuid(),
  vendorId: z.string().uuid(),
  boothInfo: z.string().max(500).optional().nullable(),
  status: z.enum([
    EVENT_VENDOR_STATUS.PENDING,
    EVENT_VENDOR_STATUS.APPROVED,
    EVENT_VENDOR_STATUS.REJECTED,
  ]).optional().default(EVENT_VENDOR_STATUS.PENDING),
  interested: z.boolean().optional(),
  applied: z.boolean().optional(),
  accepted: z.boolean().optional(),
});

// Schema for adding vendor to event (eventId comes from URL params)
export const eventVendorAddSchema = z.object({
  vendorId: z.string().uuid(),
  boothInfo: z.string().max(500).optional().nullable(),
  status: z.enum([
    EVENT_VENDOR_STATUS.PENDING,
    EVENT_VENDOR_STATUS.APPROVED,
    EVENT_VENDOR_STATUS.REJECTED,
  ]).optional().default(EVENT_VENDOR_STATUS.APPROVED),
  interested: z.boolean().optional(),
  applied: z.boolean().optional(),
  accepted: z.boolean().optional(),
});

export const eventVendorUpdateSchema = z.object({
  eventVendorId: z.string().uuid(),
  boothInfo: z.string().max(500).optional().nullable(),
  status: z.enum([
    EVENT_VENDOR_STATUS.PENDING,
    EVENT_VENDOR_STATUS.APPROVED,
    EVENT_VENDOR_STATUS.REJECTED,
  ]).optional(),
  interested: z.boolean().optional(),
  applied: z.boolean().optional(),
  accepted: z.boolean().optional(),
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
  yearEstablished: z.number().int().min(1800).max(new Date().getFullYear()).optional().nullable(),
  paymentMethods: z.array(z.string()).optional(),
  licenseInfo: z.string().max(500).optional().nullable(),
  insuranceInfo: z.string().max(500).optional().nullable(),
});

// Promoter event creation
export const promoterEventCreateSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  venueId: z.string().min(1).optional().nullable(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  categories: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  ticketUrl: urlSchema,
  ticketPriceMin: z.number().min(0).optional().nullable(),
  ticketPriceMax: z.number().min(0).optional().nullable(),
  imageUrl: urlSchema,
  eventDays: z.array(eventDaySchema).max(100, "Maximum 100 days allowed for daily schedules").optional(),
}).refine(
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
).refine(
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

// Helper function to validate and parse request body
export async function validateRequestBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<{ success: true; data: z.infer<T> } | { success: false; error: string; issues: z.ZodIssue[] }> {
  try {
    const body = await request.json();
    const result = schema.safeParse(body);

    if (!result.success) {
      return {
        success: false,
        error: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", "),
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
