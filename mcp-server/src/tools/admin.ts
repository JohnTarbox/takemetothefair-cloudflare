import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, like, inArray } from "drizzle-orm";
import { events, eventVendors, vendors, venues, promoters } from "../schema.js";
import { formatDateRange, parseJsonArray, escapeLike, jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

// ---------------------------------------------------------------------------
// Vendor status transition map — duplicated from src/lib/vendor-status.ts.
// KEEP IN SYNC with:
//   - VALID_TRANSITIONS: src/lib/vendor-status.ts
//   - EVENT_STATUS_ENUM:  src/lib/constants.ts (EventStatus)
//   - VENDOR_STATUS_ENUM: src/lib/constants.ts (VendorStatus)
//   - PAYMENT_STATUS_ENUM: src/lib/constants.ts (PaymentStatus)
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS: Record<string, string[]> = {
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

const EVENT_STATUS_ENUM = ["DRAFT", "PENDING", "TENTATIVE", "APPROVED", "REJECTED", "CANCELLED"] as const;
const VENDOR_STATUS_ENUM = ["INVITED", "INTERESTED", "APPLIED", "WAITLISTED", "APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"] as const;
const PAYMENT_STATUS_ENUM = ["NOT_REQUIRED", "PENDING", "PAID", "REFUNDED", "OVERDUE"] as const;

interface Env {
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
}

export function registerAdminTools(server: McpServer, db: Db, auth: AuthContext, env?: Env) {
  // Defense-in-depth: guard even though registration is already gated in index.ts
  if (auth.role !== "ADMIN") return;

  // ── list_all_events ────────────────────────────────────────────
  server.tool(
    "list_all_events",
    "Browse/search all events regardless of promoter ownership. Admin only.",
    {
      status: z
        .enum(EVENT_STATUS_ENUM)
        .optional()
        .describe("Filter by event status"),
      search: z
        .string()
        .optional()
        .describe("Search events by name (partial match)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results to return (default 20)"),
    },
    async (params) => {
      const conditions = [];
      if (params.status) {
        conditions.push(eq(events.status, params.status));
      }
      if (params.search) {
        conditions.push(like(events.name, `%${escapeLike(params.search)}%`));
      }

      const limit = params.limit ?? 20;

      const query = db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          status: events.status,
          featured: events.featured,
          categories: events.categories,
          imageUrl: events.imageUrl,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
          promoterName: promoters.companyName,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id));

      const eventRows = conditions.length > 0
        ? await query.where(and(...conditions)).limit(limit)
        : await query.limit(limit);

      // Batch-fetch vendor counts per event
      const eventIds = eventRows.map((e) => e.id);
      let vendorCounts: Record<string, { total: number; applied: number; confirmed: number }> = {};

      if (eventIds.length > 0) {
        const allApps = await db
          .select({
            eventId: eventVendors.eventId,
            status: eventVendors.status,
          })
          .from(eventVendors)
          .where(inArray(eventVendors.eventId, eventIds));

        for (const app of allApps) {
          if (!vendorCounts[app.eventId]) {
            vendorCounts[app.eventId] = { total: 0, applied: 0, confirmed: 0 };
          }
          vendorCounts[app.eventId].total++;
          if (app.status === "APPLIED") vendorCounts[app.eventId].applied++;
          if (app.status === "CONFIRMED" || app.status === "APPROVED") vendorCounts[app.eventId].confirmed++;
        }
      }

      const output = eventRows.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        dates: formatDateRange(e.startDate, e.endDate),
        status: e.status,
        featured: e.featured,
        location: [e.venueName, e.venueCity, e.venueState].filter(Boolean).join(", ") || "TBD",
        image_url: e.imageUrl || null,
        promoter: e.promoterName || "Unknown",
        categories: parseJsonArray(e.categories),
        vendors: vendorCounts[e.id] || { total: 0, applied: 0, confirmed: 0 },
      }));

      return { content: [jsonContent({ count: output.length, events: output })] };
    },
  );

  // ── update_event_status ────────────────────────────────────────
  server.tool(
    "update_event_status",
    "Approve, reject, or change any event's status. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      status: z
        .enum(EVENT_STATUS_ENUM)
        .describe("New event status"),
    },
    async (params) => {
      const eventRows = await db
        .select({ id: events.id, name: events.name, status: events.status })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found." }],
          isError: true,
        };
      }

      const event = eventRows[0];
      const previousStatus = event.status;

      if (previousStatus === params.status) {
        return {
          content: [{ type: "text", text: `Event is already ${params.status}.` }],
          isError: true,
        };
      }

      await db
        .update(events)
        .set({ status: params.status, updatedAt: new Date() })
        .where(eq(events.id, event.id));

      return {
        content: [
          jsonContent({
            updated: true,
            event: { id: event.id, name: event.name, previousStatus, newStatus: params.status },
          }),
        ],
      };
    },
  );

  // ── update_event ───────────────────────────────────────────────
  server.tool(
    "update_event",
    "Update event fields (name, description, dates, venue, ticket info, source info, image, etc.). Does NOT change status — use update_event_status for that. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      name: z.string().optional().describe("Event name (also regenerates slug)"),
      description: z.string().optional().describe("Event description"),
      start_date: z.string().optional().describe("Start date as ISO 8601 string"),
      end_date: z.string().optional().describe("End date as ISO 8601 string"),
      dates_confirmed: z.boolean().optional().describe("Whether dates are confirmed"),
      venue_id: z.string().optional().describe("Venue ID (FK to venues table)"),
      categories: z.array(z.string()).optional().describe("Category list, e.g. ['Craft Fair','Market']"),
      tags: z.array(z.string()).optional().describe("Tag list, e.g. ['family-friendly','outdoor']"),
      ticket_url: z.string().optional().describe("URL to buy tickets"),
      ticket_price_min: z.number().optional().describe("Minimum ticket price"),
      ticket_price_max: z.number().optional().describe("Maximum ticket price"),
      image_url: z.string().optional().describe("Event image URL"),
      featured: z.boolean().optional().describe("Whether the event is featured"),
      commercial_vendors_allowed: z.boolean().optional().describe("Whether commercial vendors are allowed"),
      source_url: z.string().optional().describe("Original source URL"),
      source_id: z.string().optional().describe("ID in the source system"),
      source_name: z.string().optional().describe("Name of the source (e.g. 'facebook', 'eventbrite')"),
      recurrence_rule: z.string().optional().describe("iCal RRULE recurrence string"),
      discontinuous_dates: z.boolean().optional().describe("Whether the event has non-consecutive dates"),
      sync_enabled: z.boolean().optional().describe("Whether automated sync is enabled"),
    },
    async (params) => {
      // Field mapping: snake_case param → camelCase Drizzle column + optional transform
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "description", column: "description" },
        { param: "venue_id", column: "venueId" },
        { param: "dates_confirmed", column: "datesConfirmed" },
        { param: "ticket_url", column: "ticketUrl" },
        { param: "ticket_price_min", column: "ticketPriceMin" },
        { param: "ticket_price_max", column: "ticketPriceMax" },
        { param: "image_url", column: "imageUrl" },
        { param: "featured", column: "featured" },
        { param: "commercial_vendors_allowed", column: "commercialVendorsAllowed" },
        { param: "source_url", column: "sourceUrl" },
        { param: "source_id", column: "sourceId" },
        { param: "source_name", column: "sourceName" },
        { param: "recurrence_rule", column: "recurrenceRule" },
        { param: "discontinuous_dates", column: "discontinuousDates" },
        { param: "sync_enabled", column: "syncEnabled" },
        {
          param: "categories",
          column: "categories",
          transform: (v: string[]) => JSON.stringify(v),
        },
        {
          param: "tags",
          column: "tags",
          transform: (v: string[]) => JSON.stringify(v),
        },
        {
          param: "start_date",
          column: "startDate",
          transform: (v: string) => {
            const d = new Date(v);
            return isNaN(d.getTime()) ? undefined : d;
          },
        },
        {
          param: "end_date",
          column: "endDate",
          transform: (v: string) => {
            const d = new Date(v);
            return isNaN(d.getTime()) ? undefined : d;
          },
        },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          const transformed = transform ? transform(value) : value;
          if (transformed !== undefined) {
            updates[column] = transformed;
            requestedFields.push(param);
          }
        }
      }

      // Handle name separately (triggers slug regeneration)
      if (params.name !== undefined) {
        updates.name = params.name;
        requestedFields.push("name");
      }

      if (requestedFields.length === 0) {
        return {
          content: [{ type: "text", text: "No fields provided to update. Supply at least one optional field." }],
          isError: true,
        };
      }

      // Validate date ordering if both are being set
      if (updates.startDate && updates.endDate) {
        if ((updates.startDate as Date) > (updates.endDate as Date)) {
          return {
            content: [{ type: "text", text: "start_date must be before or equal to end_date." }],
            isError: true,
          };
        }
      }

      // Validate venue FK exists if provided
      if (params.venue_id) {
        const venueRows = await db
          .select({ id: venues.id })
          .from(venues)
          .where(eq(venues.id, params.venue_id))
          .limit(1);
        if (venueRows.length === 0) {
          return {
            content: [{ type: "text", text: `Venue not found: ${params.venue_id}` }],
            isError: true,
          };
        }
      }

      // Fetch current event
      const eventRows = await db
        .select()
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found." }],
          isError: true,
        };
      }

      const event = eventRows[0];

      // If name changed, regenerate slug with collision check
      if (params.name !== undefined) {
        const baseSlug = params.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        let finalSlug = baseSlug;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
          const existing = await db
            .select({ id: events.id })
            .from(events)
            .where(eq(events.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === event.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
        }
        updates.slug = finalSlug;
      }

      // Always set updatedAt
      updates.updatedAt = new Date();

      // Capture previous values for confirmation
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "name") {
          previousValues.name = event.name;
          previousValues.slug = event.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (event as Record<string, unknown>)[mapping.column];
        }
      }

      // Execute update
      await db
        .update(events)
        .set(updates)
        .where(eq(events.id, event.id));

      // Build new values for confirmation
      const newValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        newValues[field] = (params as Record<string, unknown>)[field];
      }
      if (params.name !== undefined && updates.slug) {
        newValues.slug = updates.slug;
      }

      return {
        content: [
          jsonContent({
            updated: true,
            event: { id: event.id, name: updates.name ?? event.name },
            fieldsUpdated: requestedFields,
            previousValues,
            newValues,
          }),
        ],
      };
    },
  );

  // ── list_event_vendors_admin ───────────────────────────────────
  server.tool(
    "list_event_vendors_admin",
    "List all vendors for any event with full status details. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      status: z
        .enum(VENDOR_STATUS_ENUM)
        .optional()
        .describe("Filter by vendor application status"),
    },
    async (params) => {
      // Verify event exists
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found." }],
          isError: true,
        };
      }

      const conditions = [eq(eventVendors.eventId, eventRows[0].id)];
      if (params.status) {
        conditions.push(eq(eventVendors.status, params.status));
      }

      const rows = await db
        .select({
          applicationId: eventVendors.id,
          status: eventVendors.status,
          paymentStatus: eventVendors.paymentStatus,
          boothInfo: eventVendors.boothInfo,
          createdAt: eventVendors.createdAt,
          businessName: vendors.businessName,
          vendorSlug: vendors.slug,
          vendorType: vendors.vendorType,
          products: vendors.products,
          commercial: vendors.commercial,
        })
        .from(eventVendors)
        .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .where(and(...conditions));

      const output = rows.map((r) => ({
        applicationId: r.applicationId,
        status: r.status,
        paymentStatus: r.paymentStatus,
        boothInfo: r.boothInfo,
        appliedAt: r.createdAt?.toISOString() || null,
        vendor: {
          businessName: r.businessName,
          slug: r.vendorSlug,
          type: r.vendorType,
          products: parseJsonArray(r.products),
          commercial: r.commercial,
        },
      }));

      return {
        content: [
          jsonContent({ event: eventRows[0].name, count: output.length, vendors: output }),
        ],
      };
    },
  );

  // ── update_vendor_status ───────────────────────────────────────
  server.tool(
    "update_vendor_status",
    "Change a vendor's application status or payment status on an event, with transition validation. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      vendor_id: z.string().describe("Vendor ID"),
      status: z
        .enum(VENDOR_STATUS_ENUM)
        .optional()
        .describe("New vendor application status"),
      payment_status: z
        .enum(PAYMENT_STATUS_ENUM)
        .optional()
        .describe("New payment status"),
    },
    async (params) => {
      if (!params.status && !params.payment_status) {
        return {
          content: [{ type: "text", text: "Provide at least one of status or payment_status to update." }],
          isError: true,
        };
      }

      // Find the event-vendor record
      const rows = await db
        .select({
          id: eventVendors.id,
          status: eventVendors.status,
          paymentStatus: eventVendors.paymentStatus,
        })
        .from(eventVendors)
        .where(and(eq(eventVendors.eventId, params.event_id), eq(eventVendors.vendorId, params.vendor_id)))
        .limit(1);

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No vendor application found for this event/vendor combination." }],
          isError: true,
        };
      }

      const record = rows[0];
      const updates: Record<string, unknown> = {};
      const result: Record<string, unknown> = {
        updated: true,
        eventId: params.event_id,
        vendorId: params.vendor_id,
      };

      // Validate status transition
      if (params.status) {
        const allowed = VALID_TRANSITIONS[record.status];
        if (!allowed || !allowed.includes(params.status)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid transition: ${record.status} → ${params.status}. Allowed transitions from ${record.status}: ${(allowed || []).join(", ") || "none"}.`,
              },
            ],
            isError: true,
          };
        }

        updates.status = params.status;
        result.previousStatus = record.status;
        result.newStatus = params.status;
      }

      // Payment status — no transition validation, admin can set freely
      if (params.payment_status) {
        updates.paymentStatus = params.payment_status;
        result.previousPaymentStatus = record.paymentStatus;
        result.newPaymentStatus = params.payment_status;
      }

      await db
        .update(eventVendors)
        .set(updates)
        .where(eq(eventVendors.id, record.id));

      return { content: [jsonContent(result)] };
    },
  );

  // ── rescrape_events ─────────────────────────────────────────────
  server.tool(
    "rescrape_events",
    "Re-scrape specific events from their original source URLs to refresh descriptions, dates, images, and ticket URLs. Provide event IDs to re-scrape. Max 50 per request. Admin only.",
    {
      event_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Array of event IDs to re-scrape from their source URLs"),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [{ type: "text", text: "Re-scrape is not configured. MAIN_APP_URL and INTERNAL_API_KEY must be set in the MCP server environment." }],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${env.MAIN_APP_URL}/api/admin/import/rescrape-events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": env.INTERNAL_API_KEY,
          },
          body: JSON.stringify({ event_ids: params.event_ids }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({})) as Record<string, string>;
          return {
            content: [{ type: "text", text: `Re-scrape failed (${response.status}): ${errorData.error || response.statusText}` }],
            isError: true,
          };
        }

        const result = await response.json();
        return { content: [jsonContent(result)] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Re-scrape request failed: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    },
  );
}
