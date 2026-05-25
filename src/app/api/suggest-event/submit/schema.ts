import { z } from "zod";
import { decodeHtmlEntities } from "@/lib/utils";

// Sibling module so the schema can be imported by both the route
// (route.ts) and the regression test
// (__tests__/submit-schema-nullable-arrays.test.ts). Next.js
// disallows non-handler named exports from a route file, so we keep
// the schema here.

export const eventDaySchema = z.object({
  date: z.string(), // YYYY-MM-DD
  openTime: z.string(), // HH:MM
  closeTime: z.string(), // HH:MM
  notes: z.string().optional(),
  closed: z.boolean().optional(),
  vendorOnly: z.boolean().optional(),
});

export const submitEventSchema = z.object({
  name: z.string().min(1, "Event name is required").transform(decodeHtmlEntities),
  description: z.string().transform(decodeHtmlEntities).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  startTime: z.string().nullable().optional(), // HH:MM format
  endTime: z.string().nullable().optional(), // HH:MM format
  hoursVaryByDay: z.boolean().optional(),
  hoursNotes: z.string().transform(decodeHtmlEntities).nullable().optional(),
  venueId: z.string().uuid().nullable().optional(), // Link to existing venue if confirmed
  venueName: z.string().transform(decodeHtmlEntities).nullable().optional(),
  venueAddress: z.string().nullable().optional(),
  venueCity: z.string().nullable().optional(),
  venueState: z.string().nullable().optional(),
  ticketUrl: z.string().nullable().optional(),
  ticketPriceMin: z.number().nullable().optional(),
  ticketPriceMax: z.number().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  categories: z.array(z.string()).nullable().optional(),
  // Vendor decision-support fields
  vendorFeeMin: z.number().nullable().optional(),
  vendorFeeMax: z.number().nullable().optional(),
  vendorFeeNotes: z.string().transform(decodeHtmlEntities).nullable().optional(),
  indoorOutdoor: z.enum(["INDOOR", "OUTDOOR", "MIXED"]).nullable().optional(),
  estimatedAttendance: z.number().int().nullable().optional(),
  eventScale: z.enum(["SMALL", "MEDIUM", "LARGE", "MAJOR"]).nullable().optional(),
  applicationUrl: z.string().nullable().optional(),
  walkInsAllowed: z.boolean().nullable().optional(),
  sourceUrl: z.string().url().optional(),
  suggesterEmail: z.string().email().optional().or(z.literal("")),
  jsonLd: z.record(z.string(), z.unknown()).optional(),
  turnstileToken: z.string().optional(), // Turnstile verification token
  // Accept null in addition to undefined for both array fields. The AI
  // extractor (src/lib/url-import/ai-extractor.ts) emits
  // `specificDates: null` when no recurring dates are detected, and
  // the inbound-email workflow spreads `...extracted.event` into the
  // body verbatim. Before this change a bare-URL email submission
  // failed with `submit-400: Invalid input: expected array, received
  // null`, silently dropping real submissions (see inbound_emails
  // rows ebf88d81, b2667685, 3ee1848c — all 2026-05-22 → 2026-05-25).
  // Treat null the same as absent at this boundary; the downstream
  // expansion logic already truthy-checks `data.specificDates`.
  eventDays: z.array(eventDaySchema).nullable().optional(), // Per-day schedule
  // Recurring / multi-date support. When `specificDates` is provided the
  // submit pipeline expands it into eventDays rows (one per date) and sets
  // `discontinuousDates=true` on the resulting event row. Mutually
  // compatible with an explicit `eventDays` payload — eventDays wins.
  discontinuousDates: z.boolean().optional(),
  specificDates: z.array(z.string()).nullable().optional(),
  submittedByUserId: z.string().optional(), // User who submitted (auto-filled for authenticated users)
  source: z.enum(["community", "vendor", "email"]).optional(), // Submission source
});
