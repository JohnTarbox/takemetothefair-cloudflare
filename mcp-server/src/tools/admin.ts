import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, like, inArray, isNull, sql } from "drizzle-orm";
import { events, eventVendors, vendors, venues, promoters, users, eventDays } from "../schema.js";
import {
  formatDateRange,
  parseJsonArray,
  escapeLike,
  jsonContent,
  createSlug,
  parseLocation,
  VALID_TRANSITIONS,
  EVENT_STATUS_ENUM,
  VENDOR_STATUS_ENUM,
  PAYMENT_STATUS_ENUM,
  computePublicDates,
} from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
}

export function registerAdminTools(server: McpServer, db: Db, auth: AuthContext, env?: Env) {
  // Defense-in-depth: guard even though registration is already gated in index.ts
  if (auth.role !== "ADMIN") return;

  // ── list_all_events ────────────────────────────────────────────
  // Whitelist of event fields that can be filtered for NULL values
  const MISSING_FIELD_MAP: Record<string, any> = {
    venue_id: events.venueId,
    description: events.description,
    image_url: events.imageUrl,
    start_date: events.startDate,
    end_date: events.endDate,
    ticket_url: events.ticketUrl,
    source_url: events.sourceUrl,
    categories: events.categories,
    tags: events.tags,
    vendor_fee: events.vendorFeeMin,
    indoor_outdoor: events.indoorOutdoor,
    event_scale: events.eventScale,
    application_url: events.applicationUrl,
  };

  server.tool(
    "list_all_events",
    "Browse/search all events regardless of promoter ownership. Use missing_fields to find events with incomplete data (e.g. no venue, no image). Admin only.",
    {
      status: z.enum(EVENT_STATUS_ENUM).optional().describe("Filter by event status"),
      state: z
        .string()
        .optional()
        .describe("Filter by venue state (2-letter code, e.g. 'ME', 'VT')"),
      search: z.string().optional().describe("Search events by name (partial match)"),
      missing_fields: z
        .array(
          z.enum([
            "venue_id",
            "description",
            "image_url",
            "start_date",
            "end_date",
            "ticket_url",
            "source_url",
            "categories",
            "tags",
            "vendor_fee",
            "indoor_outdoor",
            "event_scale",
            "application_url",
          ])
        )
        .optional()
        .describe(
          "Filter for events where these fields are NULL/missing. E.g. ['venue_id','image_url'] returns events with no venue AND no image."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results to return (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [];
      if (params.status) {
        conditions.push(eq(events.status, params.status));
      }
      if (params.search) {
        conditions.push(like(events.name, `%${escapeLike(params.search)}%`));
      }
      if (params.state) {
        conditions.push(sql`upper(${venues.state}) = upper(${params.state})`);
      }
      if (params.missing_fields) {
        for (const field of params.missing_fields) {
          const column = MISSING_FIELD_MAP[field];
          if (column) {
            conditions.push(isNull(column));
          }
        }
      }

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

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
          venueId: events.venueId,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
          promoterId: events.promoterId,
          promoterName: promoters.companyName,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id));

      const eventRows =
        conditions.length > 0
          ? await query
              .where(and(...conditions))
              .limit(limit)
              .offset(offset)
          : await query.limit(limit).offset(offset);

      // Batch-fetch vendor counts per event
      const eventIds = eventRows.map((e) => e.id);
      const vendorCounts: Record<string, { total: number; applied: number; confirmed: number }> =
        {};

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
          if (app.status === "CONFIRMED" || app.status === "APPROVED")
            vendorCounts[app.eventId].confirmed++;
        }
      }

      const output = eventRows.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        dates: formatDateRange(e.startDate, e.endDate),
        status: e.status,
        featured: e.featured,
        venue_id: e.venueId || null,
        location: [e.venueName, e.venueCity, e.venueState].filter(Boolean).join(", ") || "TBD",
        image_url: e.imageUrl || null,
        promoter_id: e.promoterId,
        promoter: e.promoterName || "Unknown",
        categories: parseJsonArray(e.categories),
        vendors: vendorCounts[e.id] || { total: 0, applied: 0, confirmed: 0 },
      }));

      return {
        content: [
          jsonContent({
            count: output.length,
            offset,
            has_more: output.length === limit,
            events: output,
          }),
        ],
      };
    }
  );

  // ── update_event_status ────────────────────────────────────────
  server.tool(
    "update_event_status",
    "Approve, reject, or change any event's status. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      status: z.enum(EVENT_STATUS_ENUM).describe("New event status"),
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
    }
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
      promoter_id: z.string().optional().describe("Promoter ID (FK to promoters table)"),
      categories: z
        .array(z.string())
        .optional()
        .describe("Category list, e.g. ['Craft Fair','Market']"),
      tags: z.array(z.string()).optional().describe("Tag list, e.g. ['family-friendly','outdoor']"),
      ticket_url: z.string().optional().describe("URL to buy tickets"),
      ticket_price_min: z.number().optional().describe("Minimum ticket price"),
      ticket_price_max: z.number().optional().describe("Maximum ticket price"),
      image_url: z.string().optional().describe("Event image URL"),
      featured: z.boolean().optional().describe("Whether the event is featured"),
      commercial_vendors_allowed: z
        .boolean()
        .optional()
        .describe("Whether commercial vendors are allowed"),
      vendor_fee_min: z.number().optional().describe("Minimum vendor/booth fee"),
      vendor_fee_max: z.number().optional().describe("Maximum vendor/booth fee"),
      vendor_fee_notes: z.string().optional().describe("Details about vendor/booth fees"),
      indoor_outdoor: z
        .enum(["INDOOR", "OUTDOOR", "MIXED"])
        .optional()
        .describe("Indoor/outdoor designation"),
      estimated_attendance: z.number().int().optional().describe("Expected attendance count"),
      event_scale: z
        .enum(["SMALL", "MEDIUM", "LARGE", "MAJOR"])
        .optional()
        .describe("Event scale category"),
      application_deadline: z
        .string()
        .optional()
        .describe("Vendor application deadline (ISO 8601)"),
      application_url: z.string().optional().describe("URL for vendor applications"),
      application_instructions: z.string().optional().describe("How to apply as a vendor"),
      walk_ins_allowed: z.boolean().optional().describe("Whether walk-in vendors are accepted"),
      source_url: z.string().optional().describe("Original source URL"),
      source_id: z.string().optional().describe("ID in the source system"),
      source_name: z
        .string()
        .optional()
        .describe("Name of the source (e.g. 'facebook', 'eventbrite')"),
      recurrence_rule: z.string().optional().describe("iCal RRULE recurrence string"),
      discontinuous_dates: z
        .boolean()
        .optional()
        .describe("Whether the event has non-consecutive dates"),
      sync_enabled: z.boolean().optional().describe("Whether automated sync is enabled"),
      venue_name: z
        .string()
        .optional()
        .describe("Update linked venue's name (convenience shortcut)"),
      venue_address: z.string().optional().describe("Update linked venue's street address"),
      venue_city: z.string().optional().describe("Update linked venue's city"),
      venue_state: z.string().optional().describe("Update linked venue's state (2-letter code)"),
      venue_zip: z.string().optional().describe("Update linked venue's ZIP code"),
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
        { param: "promoter_id", column: "promoterId" },
        { param: "dates_confirmed", column: "datesConfirmed" },
        { param: "ticket_url", column: "ticketUrl" },
        { param: "ticket_price_min", column: "ticketPriceMin" },
        { param: "ticket_price_max", column: "ticketPriceMax" },
        { param: "image_url", column: "imageUrl" },
        { param: "featured", column: "featured" },
        { param: "commercial_vendors_allowed", column: "commercialVendorsAllowed" },
        { param: "vendor_fee_min", column: "vendorFeeMin" },
        { param: "vendor_fee_max", column: "vendorFeeMax" },
        { param: "vendor_fee_notes", column: "vendorFeeNotes" },
        { param: "indoor_outdoor", column: "indoorOutdoor" },
        { param: "estimated_attendance", column: "estimatedAttendance" },
        { param: "event_scale", column: "eventScale" },
        {
          param: "application_deadline",
          column: "applicationDeadline",
          transform: (v: string) => new Date(v),
        },
        { param: "application_url", column: "applicationUrl" },
        { param: "application_instructions", column: "applicationInstructions" },
        { param: "walk_ins_allowed", column: "walkInsAllowed" },
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

      // Collect inline venue fields
      const venueFieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "venue_name", column: "name" },
        { param: "venue_address", column: "address" },
        { param: "venue_city", column: "city" },
        { param: "venue_state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "venue_zip", column: "zip" },
      ];
      const venueUpdates: Record<string, unknown> = {};
      const venueRequestedFields: string[] = [];
      for (const { param, column, transform } of venueFieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          venueUpdates[column] = transform ? transform(value) : value;
          venueRequestedFields.push(param);
        }
      }

      if (requestedFields.length === 0 && venueRequestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
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

      // Validate promoter FK exists if provided
      if (params.promoter_id) {
        const promoterRows = await db
          .select({ id: promoters.id })
          .from(promoters)
          .where(eq(promoters.id, params.promoter_id))
          .limit(1);
        if (promoterRows.length === 0) {
          return {
            content: [{ type: "text", text: `Promoter not found: ${params.promoter_id}` }],
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

      // Execute event update (skip if only venue fields provided)
      if (requestedFields.length > 0) {
        await db.update(events).set(updates).where(eq(events.id, event.id));
      }

      // Build new values for confirmation
      const newValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        newValues[field] = (params as Record<string, unknown>)[field];
      }
      if (params.name !== undefined && updates.slug) {
        newValues.slug = updates.slug;
      }

      // Handle inline venue field updates
      let venueUpdateResult: Record<string, unknown> | null = null;
      if (venueRequestedFields.length > 0) {
        // Determine which venue to update
        const targetVenueId = params.venue_id ?? event.venueId;
        if (!targetVenueId) {
          return {
            content: [
              {
                type: "text",
                text: "Event has no linked venue. Use create_venue + venue_id to link one first.",
              },
            ],
            isError: true,
          };
        }

        // Fetch current venue for previous values
        const venueRows = await db
          .select()
          .from(venues)
          .where(eq(venues.id, targetVenueId))
          .limit(1);

        if (venueRows.length === 0) {
          return {
            content: [{ type: "text", text: `Linked venue not found: ${targetVenueId}` }],
            isError: true,
          };
        }

        const venue = venueRows[0];
        const venuePreviousValues: Record<string, unknown> = {};
        const venueNewValues: Record<string, unknown> = {};

        for (const field of venueRequestedFields) {
          const mapping = venueFieldMap.find((f) => f.param === field);
          if (mapping) {
            venuePreviousValues[field] = (venue as Record<string, unknown>)[mapping.column];
            venueNewValues[field] = (params as Record<string, unknown>)[field];
          }
        }

        // If venue_name changed, regenerate slug
        if (venueUpdates.name !== undefined) {
          const baseSlug = createSlug(venueUpdates.name as string);
          let finalSlug = baseSlug;
          let suffix = 0;
          while (true) {
            const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
            const existing = await db
              .select({ id: venues.id })
              .from(venues)
              .where(eq(venues.slug, candidate))
              .limit(1);
            if (existing.length === 0 || existing[0].id === venue.id) {
              finalSlug = candidate;
              break;
            }
            suffix++;
            if (suffix > 20) break;
          }
          venueUpdates.slug = finalSlug;
          venuePreviousValues.slug = venue.slug;
          venueNewValues.slug = finalSlug;
        }

        venueUpdates.updatedAt = new Date();
        await db.update(venues).set(venueUpdates).where(eq(venues.id, venue.id));

        venueUpdateResult = {
          venue_id: venue.id,
          venue_name: venue.name,
          fieldsUpdated: venueRequestedFields,
          previousValues: venuePreviousValues,
          newValues: venueNewValues,
        };
      }

      const result: Record<string, unknown> = {
        updated: true,
        event: { id: event.id, name: updates.name ?? event.name },
      };
      if (requestedFields.length > 0) {
        result.fieldsUpdated = requestedFields;
        result.previousValues = previousValues;
        result.newValues = newValues;
      }
      if (venueUpdateResult) {
        result.venueUpdated = venueUpdateResult;
      }

      return { content: [jsonContent(result)] };
    }
  );

  // ── list_event_vendors_admin ───────────────────────────────────
  server.tool(
    "list_event_vendors_admin",
    "List all vendors for any event with full status details. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      status: z.enum(VENDOR_STATUS_ENUM).optional().describe("Filter by vendor application status"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
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

      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;

      const conditions = [eq(eventVendors.eventId, eventRows[0].id)];
      if (params.status) {
        conditions.push(eq(eventVendors.status, params.status));
      }

      const rows = await db
        .select({
          applicationId: eventVendors.id,
          vendorId: eventVendors.vendorId,
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
        .where(and(...conditions))
        .limit(limit)
        .offset(offset);

      const output = rows.map((r) => ({
        applicationId: r.applicationId,
        status: r.status,
        paymentStatus: r.paymentStatus,
        boothInfo: r.boothInfo,
        appliedAt: r.createdAt?.toISOString() || null,
        vendor: {
          id: r.vendorId,
          businessName: r.businessName,
          slug: r.vendorSlug,
          type: r.vendorType,
          products: parseJsonArray(r.products),
          commercial: r.commercial,
        },
      }));

      return {
        content: [
          jsonContent({
            event: eventRows[0].name,
            count: output.length,
            offset,
            has_more: output.length === limit,
            vendors: output,
          }),
        ],
      };
    }
  );

  // ── create_vendor ──────────────────────────────────────────────
  server.tool(
    "create_vendor",
    "Create a new vendor profile on the platform. Returns the vendor ID for use with update_vendor_status to link to events. Admin only.",
    {
      business_name: z.string().min(1).max(200).describe("Business/organization name"),
      type: z
        .string()
        .max(100)
        .optional()
        .describe("Vendor category (e.g. 'Home Improvement', 'Food', 'Crafts')"),
      description: z.string().max(500).optional().describe("Business description"),
      products: z.array(z.string()).optional().describe("List of products/services offered"),
      location: z.string().optional().describe("City and state, e.g. 'Portland, ME'"),
      website: z.string().optional().describe("Vendor website URL"),
      contact_email: z.string().optional().describe("Primary contact email address"),
      contact_phone: z.string().optional().describe("Contact phone number"),
      logo_url: z.string().optional().describe("URL to vendor logo image"),
    },
    async (params) => {
      // Check for duplicate business name (exact match, case-insensitive via LIKE)
      const existing = await db
        .select({ id: vendors.id, slug: vendors.slug })
        .from(vendors)
        .where(eq(vendors.businessName, params.business_name))
        .limit(1);

      if (existing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `A vendor with the name "${params.business_name}" already exists (slug: ${existing[0].slug}). Use search_vendors to find it.`,
            },
          ],
          isError: true,
        };
      }

      // Generate unique slug
      const baseSlug = createSlug(params.business_name);
      if (!baseSlug) {
        return {
          content: [
            { type: "text", text: "Could not generate a valid slug from the business name." },
          ],
          isError: true,
        };
      }

      let finalSlug = baseSlug;
      let suffix = 0;
      while (true) {
        const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
        const slugCheck = await db
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.slug, candidate))
          .limit(1);
        if (slugCheck.length === 0) {
          finalSlug = candidate;
          break;
        }
        suffix++;
        if (suffix > 20) {
          return {
            content: [
              { type: "text", text: "Too many slug collisions. Try a more unique business name." },
            ],
            isError: true,
          };
        }
      }

      // Create placeholder user (vendor table requires userId FK)
      const placeholderEmail = `pending+${finalSlug}@meetmeatthefair.com`;
      const userId = crypto.randomUUID();

      await db.insert(users).values({
        id: userId,
        email: placeholderEmail,
        role: "VENDOR",
      });

      // Parse location into city/state
      const loc = params.location ? parseLocation(params.location) : { city: null, state: null };

      // Create vendor record
      const vendorId = crypto.randomUUID();

      await db.insert(vendors).values({
        id: vendorId,
        userId,
        businessName: params.business_name,
        slug: finalSlug,
        vendorType: params.type ?? null,
        description: params.description ?? null,
        products: params.products ? JSON.stringify(params.products) : "[]",
        website: params.website ?? null,
        contactEmail: params.contact_email ?? null,
        contactPhone: params.contact_phone ?? null,
        logoUrl: params.logo_url ?? null,
        city: loc.city,
        state: loc.state,
      });

      return {
        content: [
          jsonContent({
            created: true,
            vendor_id: vendorId,
            slug: finalSlug,
            business_name: params.business_name,
          }),
        ],
      };
    }
  );

  // ── update_vendor_status ───────────────────────────────────────
  server.tool(
    "update_vendor_status",
    "Change a vendor's application status or payment status on an event. If no vendor-event link exists, creates one (upsert). Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      vendor_id: z.string().describe("Vendor ID"),
      status: z.enum(VENDOR_STATUS_ENUM).optional().describe("New vendor application status"),
      payment_status: z.enum(PAYMENT_STATUS_ENUM).optional().describe("New payment status"),
    },
    async (params) => {
      if (!params.status && !params.payment_status) {
        return {
          content: [
            { type: "text", text: "Provide at least one of status or payment_status to update." },
          ],
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
        .where(
          and(
            eq(eventVendors.eventId, params.event_id),
            eq(eventVendors.vendorId, params.vendor_id)
          )
        )
        .limit(1);

      // ── UPSERT: create vendor-event link if none exists ──
      if (rows.length === 0) {
        // Verify event exists
        const eventCheck = await db
          .select({ id: events.id, name: events.name })
          .from(events)
          .where(eq(events.id, params.event_id))
          .limit(1);
        if (eventCheck.length === 0) {
          return { content: [{ type: "text", text: "Event not found." }], isError: true };
        }

        // Verify vendor exists
        const vendorCheck = await db
          .select({ id: vendors.id, businessName: vendors.businessName })
          .from(vendors)
          .where(eq(vendors.id, params.vendor_id))
          .limit(1);
        if (vendorCheck.length === 0) {
          return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
        }

        const newStatus = params.status ?? "INVITED";
        const newPaymentStatus = params.payment_status ?? "NOT_REQUIRED";

        await db.insert(eventVendors).values({
          eventId: params.event_id,
          vendorId: params.vendor_id,
          status: newStatus,
          paymentStatus: newPaymentStatus,
        });

        return {
          content: [
            jsonContent({
              created: true,
              eventId: params.event_id,
              eventName: eventCheck[0].name,
              vendorId: params.vendor_id,
              vendorName: vendorCheck[0].businessName,
              status: newStatus,
              paymentStatus: newPaymentStatus,
            }),
          ],
        };
      }

      // ── UPDATE existing record ──
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

      await db.update(eventVendors).set(updates).where(eq(eventVendors.id, record.id));

      return { content: [jsonContent(result)] };
    }
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
          content: [
            {
              type: "text",
              text: "Re-scrape is not configured. MAIN_APP_URL and INTERNAL_API_KEY must be set in the MCP server environment.",
            },
          ],
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
          const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
          return {
            content: [
              {
                type: "text",
                text: `Re-scrape failed (${response.status}): ${errorData.error || response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const result = await response.json();
        return { content: [jsonContent(result)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Re-scrape request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── Analytics tools (read-only, proxy to Next.js API) ───────────
  // All four call the main app's admin analytics endpoints with an
  // X-Internal-Key header. MAIN_APP_URL + INTERNAL_API_KEY must both
  // be set in the MCP worker environment.

  async function fetchAnalyticsJson(path: string): Promise<unknown> {
    if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
      throw new Error(
        "Analytics requires MAIN_APP_URL and INTERNAL_API_KEY to be configured in the MCP server environment."
      );
    }
    const response = await fetch(`${env.MAIN_APP_URL}${path}`, {
      method: "GET",
      headers: { "X-Internal-Key": env.INTERNAL_API_KEY },
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Analytics API returned non-JSON (${response.status}): ${text.slice(0, 200)}`
      );
    }
    if (!response.ok) {
      const errObj = parsed as { error?: string; message?: string };
      throw new Error(
        `Analytics API error (${response.status}): ${errObj.message ?? errObj.error ?? "unknown"}`
      );
    }
    return parsed;
  }

  // Shared Zod schemas for analytics date-range + filter params
  const PRESET_LABELS = [
    "last_7d",
    "last_28d",
    "last_30d",
    "last_90d",
    "last_365d",
    "mtd",
    "ytd",
    "prev_7d",
    "prev_28d",
  ] as const;
  const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
  const dateRangeFields = {
    startDate: z
      .string()
      .regex(ISO_DATE_REGEX)
      .optional()
      .describe("Inclusive start date, ISO YYYY-MM-DD. Mutually exclusive with preset."),
    endDate: z
      .string()
      .regex(ISO_DATE_REGEX)
      .optional()
      .describe("Inclusive end date, ISO YYYY-MM-DD. Defaults to yesterday."),
    preset: z
      .enum(PRESET_LABELS)
      .optional()
      .describe(
        "Named date range. Use instead of startDate/endDate. Options: last_7d, last_28d, last_30d, last_90d, last_365d, mtd, ytd, prev_7d, prev_28d."
      ),
  };

  function buildDateQuery(params: {
    startDate?: string;
    endDate?: string;
    preset?: string;
    refresh?: boolean;
  }): URLSearchParams {
    const qs = new URLSearchParams();
    if (params.startDate) qs.set("startDate", params.startDate);
    if (params.endDate) qs.set("endDate", params.endDate);
    if (params.preset) qs.set("preset", params.preset);
    if (params.refresh) qs.set("refresh", "1");
    return qs;
  }

  server.tool(
    "get_analytics_overview",
    "Site-wide GA4 overview: active users, top pages, top events, top traffic sources. Default window is last 28 days ending yesterday; pass preset or startDate/endDate to override. Pass comparePreviousPeriod:true for delta vs the prior equal-length period. Admin only.",
    {
      ...dateRangeFields,
      comparePreviousPeriod: z
        .boolean()
        .optional()
        .describe(
          "When true, response adds previousTotals for the period immediately preceding the requested range. Default false."
        ),
      pathPrefix: z
        .string()
        .optional()
        .describe("Filter topPages array to paths starting with this prefix (e.g. '/blog/')."),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max rows in topPages (default 20, max 200)."),
      orderBy: z
        .enum(["views", "users", "sessions", "engagementRate"])
        .optional()
        .describe("Sort order for topPages (default views)."),
      minViews: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop topPages rows with fewer views than this."),
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        if (params.comparePreviousPeriod) qs.set("comparePreviousPeriod", "true");
        if (params.pathPrefix) qs.set("pathPrefix", params.pathPrefix);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        if (params.orderBy) qs.set("orderBy", params.orderBy);
        if (params.minViews !== undefined) qs.set("minViews", String(params.minViews));
        const q = qs.toString();
        const data = await fetchAnalyticsJson(`/api/admin/analytics/ga4${q ? "?" + q : ""}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error fetching overview",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_top_pages",
    "Top pages by traffic over a date window. Defaults to top 20 for the last 28 days; use pathPrefix to scope to a subtree (e.g. '/blog/'), rowLimit to fetch more, orderBy to sort differently. Admin only.",
    {
      ...dateRangeFields,
      pathPrefix: z
        .string()
        .optional()
        .describe("Filter to paths starting with this (e.g. '/blog/', '/events/')."),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max rows to return (default 20, max 200)."),
      orderBy: z
        .enum(["views", "users", "sessions", "engagementRate"])
        .optional()
        .describe("Sort order (default views)."),
      minViews: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop rows with fewer views than this."),
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        if (params.pathPrefix) qs.set("pathPrefix", params.pathPrefix);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        if (params.orderBy) qs.set("orderBy", params.orderBy);
        if (params.minViews !== undefined) qs.set("minViews", String(params.minViews));
        const q = qs.toString();
        const data = (await fetchAnalyticsJson(`/api/admin/analytics/ga4${q ? "?" + q : ""}`)) as {
          success: boolean;
          metrics?: { topPages?: unknown; dateRange?: unknown; generatedAt?: string };
        };
        return {
          content: [
            jsonContent({
              topPages: data.metrics?.topPages ?? [],
              dateRange: data.metrics?.dateRange,
              generatedAt: data.metrics?.generatedAt,
            }),
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error listing top pages",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_page_analytics",
    "Detailed analytics for a single page path: totals with period-over-period deltas, daily views series, traffic sources, device breakdown, and GA4 events fired on that page. Defaults to last 28 days; pass preset or startDate/endDate to override. Admin only.",
    {
      path: z
        .string()
        .startsWith("/")
        .describe("URL path, must begin with '/'. Example: '/events' or '/blog/my-post'"),
      ...dateRangeFields,
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        qs.set("path", params.path);
        const data = await fetchAnalyticsJson(`/api/admin/analytics/page?${qs.toString()}`);
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching page analytics",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_search_queries",
    "Top Google Search Console queries that led to a specific page. Returns query text, clicks, impressions, CTR, and average SERP position. Default window is last 30 days ending 3 days ago (to account for GSC reporting lag). Admin only.",
    {
      path: z
        .string()
        .startsWith("/")
        .describe("URL path, must begin with '/'. Example: '/events' or '/blog/my-post'"),
      ...dateRangeFields,
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows to return (default 15, max 500)."),
      refresh: z.boolean().optional().describe("Bypass the 15-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        qs.set("path", params.path);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        const data = await fetchAnalyticsJson(
          `/api/admin/analytics/search-queries?${qs.toString()}`
        );
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error ? error.message : "Unknown error fetching search queries",
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_top_search_queries",
    "Site-wide top Google Search Console queries aggregated across all pages. Each query row includes its top 3 ranking pages. Filter by pathPrefix (e.g. '/blog/') to scope to a subtree. Default window is last 28 days ending 3 days ago. Use this to find SEO opportunities without walking each page individually. Admin only.",
    {
      ...dateRangeFields,
      pathPrefix: z
        .string()
        .optional()
        .describe(
          "Only include queries where at least one impression came from a path starting with this prefix (e.g. '/blog/')."
        ),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max queries to return (default 50, max 500)."),
      minImpressions: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop queries with fewer impressions than this."),
      orderBy: z
        .enum(["impressions", "clicks", "position", "ctr"])
        .optional()
        .describe("Sort order (default impressions desc; position sorts ascending)."),
      refresh: z.boolean().optional().describe("Bypass the 15-minute cache (default false)."),
    },
    async (params) => {
      try {
        const qs = buildDateQuery(params);
        if (params.pathPrefix) qs.set("pathPrefix", params.pathPrefix);
        if (params.rowLimit !== undefined) qs.set("rowLimit", String(params.rowLimit));
        if (params.minImpressions !== undefined)
          qs.set("minImpressions", String(params.minImpressions));
        if (params.orderBy) qs.set("orderBy", params.orderBy);
        const q = qs.toString();
        const data = await fetchAnalyticsJson(
          `/api/admin/analytics/search-queries/site${q ? "?" + q : ""}`
        );
        return { content: [jsonContent(data)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown error fetching site-wide search queries",
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── update_venue ──────────────────────────────────────────────
  server.tool(
    "update_venue",
    "Update venue fields (name, address, coordinates, etc.). Admin only.",
    {
      venue_id: z.string().describe("Venue ID (UUID)"),
      name: z.string().optional().describe("Venue name (also regenerates slug)"),
      address: z.string().optional().describe("Street address"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      zip: z.string().optional().describe("ZIP code"),
      latitude: z.number().optional().describe("Latitude coordinate"),
      longitude: z.number().optional().describe("Longitude coordinate"),
      description: z.string().optional().describe("Venue description"),
      capacity: z.number().int().optional().describe("Venue capacity"),
      website: z.string().optional().describe("Website URL"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      image_url: z.string().optional().describe("Venue image URL"),
      status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Venue status"),
    },
    async (params) => {
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "address", column: "address" },
        { param: "city", column: "city" },
        { param: "state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "zip", column: "zip" },
        { param: "latitude", column: "latitude" },
        { param: "longitude", column: "longitude" },
        { param: "description", column: "description" },
        { param: "capacity", column: "capacity" },
        { param: "website", column: "website" },
        { param: "contact_email", column: "contactEmail" },
        { param: "contact_phone", column: "contactPhone" },
        { param: "image_url", column: "imageUrl" },
        { param: "status", column: "status" },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          updates[column] = transform ? transform(value) : value;
          requestedFields.push(param);
        }
      }

      if (params.name !== undefined) {
        updates.name = params.name;
        requestedFields.push("name");
      }

      if (requestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
          isError: true,
        };
      }

      // Fetch current venue
      const venueRows = await db
        .select()
        .from(venues)
        .where(eq(venues.id, params.venue_id))
        .limit(1);

      if (venueRows.length === 0) {
        return { content: [{ type: "text", text: "Venue not found." }], isError: true };
      }

      const venue = venueRows[0];

      // If name changed, regenerate slug with collision check
      if (params.name !== undefined) {
        const baseSlug = createSlug(params.name);
        let finalSlug = baseSlug;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
          const existing = await db
            .select({ id: venues.id })
            .from(venues)
            .where(eq(venues.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === venue.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                { type: "text", text: "Too many slug collisions. Try a more unique name." },
              ],
              isError: true,
            };
          }
        }
        updates.slug = finalSlug;
      }

      updates.updatedAt = new Date();

      // Capture previous values
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "name") {
          previousValues.name = venue.name;
          previousValues.slug = venue.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (venue as Record<string, unknown>)[mapping.column];
        }
      }

      await db.update(venues).set(updates).where(eq(venues.id, venue.id));

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
            venue: { id: venue.id, name: updates.name ?? venue.name },
            fieldsUpdated: requestedFields,
            previousValues,
            newValues,
          }),
        ],
      };
    }
  );

  // ── create_venue ──────────────────────────────────────────────
  server.tool(
    "create_venue",
    "Create a new venue record. Returns the venue ID for use with update_event. Admin only.",
    {
      name: z.string().min(1).max(200).describe("Venue name"),
      address: z.string().min(1).describe("Street address"),
      city: z.string().min(1).describe("City"),
      state: z.string().min(1).max(2).describe("State (2-letter code)"),
      zip: z.string().min(1).describe("ZIP code"),
      latitude: z.number().optional().describe("Latitude coordinate"),
      longitude: z.number().optional().describe("Longitude coordinate"),
      capacity: z.number().int().optional().describe("Venue capacity"),
      website: z.string().optional().describe("Website URL"),
      description: z.string().optional().describe("Venue description"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      image_url: z.string().optional().describe("Venue image URL"),
    },
    async (params) => {
      // Warn on potential duplicate (same name + city + state)
      const dupeCheck = await db
        .select({ id: venues.id, slug: venues.slug })
        .from(venues)
        .where(
          and(
            eq(venues.name, params.name),
            eq(venues.city, params.city),
            sql`upper(${venues.state}) = upper(${params.state})`
          )
        )
        .limit(1);

      if (dupeCheck.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `A venue named "${params.name}" already exists in ${params.city}, ${params.state} (slug: ${dupeCheck[0].slug}, id: ${dupeCheck[0].id}). Use update_venue to modify it, or choose a different name.`,
            },
          ],
          isError: true,
        };
      }

      // Generate unique slug
      const baseSlug = createSlug(params.name);
      if (!baseSlug) {
        return {
          content: [{ type: "text", text: "Could not generate a valid slug from the venue name." }],
          isError: true,
        };
      }

      let finalSlug = baseSlug;
      let suffix = 0;
      while (true) {
        const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
        const slugCheck = await db
          .select({ id: venues.id })
          .from(venues)
          .where(eq(venues.slug, candidate))
          .limit(1);
        if (slugCheck.length === 0) {
          finalSlug = candidate;
          break;
        }
        suffix++;
        if (suffix > 20) {
          return {
            content: [{ type: "text", text: "Too many slug collisions. Try a more unique name." }],
            isError: true,
          };
        }
      }

      const venueId = crypto.randomUUID();

      await db.insert(venues).values({
        id: venueId,
        name: params.name,
        slug: finalSlug,
        address: params.address,
        city: params.city,
        state: params.state.toUpperCase(),
        zip: params.zip,
        latitude: params.latitude ?? null,
        longitude: params.longitude ?? null,
        capacity: params.capacity ?? null,
        website: params.website ?? null,
        description: params.description ?? null,
        contactEmail: params.contact_email ?? null,
        contactPhone: params.contact_phone ?? null,
        imageUrl: params.image_url ?? null,
      });

      return {
        content: [
          jsonContent({
            created: true,
            venue_id: venueId,
            slug: finalSlug,
            name: params.name,
            location: `${params.city}, ${params.state.toUpperCase()}`,
          }),
        ],
      };
    }
  );

  // ── update_vendor ─────────────────────────────────────────────
  server.tool(
    "update_vendor",
    "Update any vendor's profile fields. Admin only.",
    {
      vendor_id: z.string().describe("Vendor ID (UUID)"),
      business_name: z.string().optional().describe("Business name (also regenerates slug)"),
      vendor_type: z.string().optional().describe("Vendor category"),
      description: z.string().optional().describe("Business description"),
      products: z.array(z.string()).optional().describe("Products/services list"),
      website: z.string().optional().describe("Website URL"),
      contact_name: z.string().optional().describe("Contact person name"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      address: z.string().optional().describe("Street address"),
      zip: z.string().optional().describe("ZIP code"),
      logo_url: z.string().optional().describe("Logo image URL"),
      social_links: z.string().optional().describe("Social media links (JSON string)"),
      verified: z.boolean().optional().describe("Verified status"),
      commercial: z.boolean().optional().describe("Commercial vendor flag"),
      can_self_confirm: z
        .boolean()
        .optional()
        .describe("Whether vendor can auto-confirm applications"),
    },
    async (params) => {
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "vendor_type", column: "vendorType" },
        { param: "description", column: "description" },
        { param: "products", column: "products", transform: (v: string[]) => JSON.stringify(v) },
        { param: "website", column: "website" },
        { param: "contact_name", column: "contactName" },
        { param: "contact_email", column: "contactEmail" },
        { param: "contact_phone", column: "contactPhone" },
        { param: "city", column: "city" },
        { param: "state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "address", column: "address" },
        { param: "zip", column: "zip" },
        { param: "logo_url", column: "logoUrl" },
        { param: "social_links", column: "socialLinks" },
        { param: "verified", column: "verified" },
        { param: "commercial", column: "commercial" },
        { param: "can_self_confirm", column: "canSelfConfirm" },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          updates[column] = transform ? transform(value) : value;
          requestedFields.push(param);
        }
      }

      if (params.business_name !== undefined) {
        updates.businessName = params.business_name;
        requestedFields.push("business_name");
      }

      if (requestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
          isError: true,
        };
      }

      // Fetch current vendor
      const vendorRows = await db
        .select()
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);

      if (vendorRows.length === 0) {
        return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
      }

      const vendor = vendorRows[0];

      // If business_name changed, regenerate slug
      if (params.business_name !== undefined) {
        const baseSlug = createSlug(params.business_name);
        let finalSlug = baseSlug;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
          const existing = await db
            .select({ id: vendors.id })
            .from(vendors)
            .where(eq(vendors.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === vendor.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                { type: "text", text: "Too many slug collisions. Try a more unique name." },
              ],
              isError: true,
            };
          }
        }
        updates.slug = finalSlug;
      }

      updates.updatedAt = new Date();

      // Capture previous values
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "business_name") {
          previousValues.business_name = vendor.businessName;
          previousValues.slug = vendor.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (vendor as Record<string, unknown>)[mapping.column];
        }
      }

      await db.update(vendors).set(updates).where(eq(vendors.id, vendor.id));

      const newValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        newValues[field] = (params as Record<string, unknown>)[field];
      }
      if (params.business_name !== undefined && updates.slug) {
        newValues.slug = updates.slug;
      }

      return {
        content: [
          jsonContent({
            updated: true,
            vendor: { id: vendor.id, businessName: updates.businessName ?? vendor.businessName },
            fieldsUpdated: requestedFields,
            previousValues,
            newValues,
          }),
        ],
      };
    }
  );

  // ── create_promoter ────────────────────────────────────────────
  server.tool(
    "create_promoter",
    "Create a new promoter (event organizer) on the platform. Returns the promoter ID for use with update_event to link events. Admin only.",
    {
      name: z.string().min(1).max(200).describe("Company/organization name"),
      website: z.string().optional().describe("Promoter website URL"),
      description: z.string().max(500).optional().describe("Promoter description"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      contact_email: z.string().optional().describe("Primary contact email address"),
      contact_phone: z.string().optional().describe("Contact phone number"),
      logo_url: z.string().optional().describe("URL to promoter logo image"),
    },
    async (params) => {
      // Check for duplicate company name (exact match)
      const existing = await db
        .select({ id: promoters.id, slug: promoters.slug })
        .from(promoters)
        .where(eq(promoters.companyName, params.name))
        .limit(1);

      if (existing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `A promoter with the name "${params.name}" already exists (slug: ${existing[0].slug}). Use search_promoters to find it.`,
            },
          ],
          isError: true,
        };
      }

      // Generate unique slug
      const baseSlug = createSlug(params.name);
      if (!baseSlug) {
        return {
          content: [{ type: "text", text: "Could not generate a valid slug from the name." }],
          isError: true,
        };
      }

      let finalSlug = baseSlug;
      let suffix = 0;
      while (true) {
        const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
        const slugCheck = await db
          .select({ id: promoters.id })
          .from(promoters)
          .where(eq(promoters.slug, candidate))
          .limit(1);
        if (slugCheck.length === 0) {
          finalSlug = candidate;
          break;
        }
        suffix++;
        if (suffix > 20) {
          return {
            content: [{ type: "text", text: "Too many slug collisions. Try a more unique name." }],
            isError: true,
          };
        }
      }

      // Create placeholder user (promoters table has userId FK)
      const placeholderEmail = `pending+promoter-${finalSlug}@meetmeatthefair.com`;
      const userId = crypto.randomUUID();

      await db.insert(users).values({
        id: userId,
        email: placeholderEmail,
        role: "PROMOTER",
      });

      // Create promoter record
      const promoterId = crypto.randomUUID();

      await db.insert(promoters).values({
        id: promoterId,
        userId,
        companyName: params.name,
        slug: finalSlug,
        description: params.description ?? null,
        website: params.website ?? null,
        logoUrl: params.logo_url ?? null,
        city: params.city ?? null,
        state: params.state ? params.state.toUpperCase() : null,
        contactEmail: params.contact_email ?? null,
        contactPhone: params.contact_phone ?? null,
      });

      return {
        content: [
          jsonContent({
            created: true,
            promoter_id: promoterId,
            slug: finalSlug,
            name: params.name,
          }),
        ],
      };
    }
  );

  // ── update_promoter ───────────────────────────────────────────
  server.tool(
    "update_promoter",
    "Update any promoter's profile fields. Admin only.",
    {
      promoter_id: z.string().describe("Promoter ID (UUID)"),
      name: z.string().optional().describe("Company name (also regenerates slug)"),
      description: z.string().optional().describe("Promoter description"),
      website: z.string().optional().describe("Website URL"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      logo_url: z.string().optional().describe("Logo image URL"),
      social_links: z.string().optional().describe("Social media links (JSON string)"),
      verified: z.boolean().optional().describe("Verified status"),
    },
    async (params) => {
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "description", column: "description" },
        { param: "website", column: "website" },
        { param: "city", column: "city" },
        { param: "state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "contact_email", column: "contactEmail" },
        { param: "contact_phone", column: "contactPhone" },
        { param: "logo_url", column: "logoUrl" },
        { param: "social_links", column: "socialLinks" },
        { param: "verified", column: "verified" },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          updates[column] = transform ? transform(value) : value;
          requestedFields.push(param);
        }
      }

      if (params.name !== undefined) {
        updates.companyName = params.name;
        requestedFields.push("name");
      }

      if (requestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
          isError: true,
        };
      }

      // Fetch current promoter
      const promoterRows = await db
        .select()
        .from(promoters)
        .where(eq(promoters.id, params.promoter_id))
        .limit(1);

      if (promoterRows.length === 0) {
        return { content: [{ type: "text", text: "Promoter not found." }], isError: true };
      }

      const promoter = promoterRows[0];

      // If name changed, regenerate slug
      if (params.name !== undefined) {
        const baseSlug = createSlug(params.name);
        let finalSlug = baseSlug;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? `${baseSlug}-${suffix}` : baseSlug;
          const existing = await db
            .select({ id: promoters.id })
            .from(promoters)
            .where(eq(promoters.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === promoter.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                { type: "text", text: "Too many slug collisions. Try a more unique name." },
              ],
              isError: true,
            };
          }
        }
        updates.slug = finalSlug;
      }

      updates.updatedAt = new Date();

      // Capture previous values
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "name") {
          previousValues.name = promoter.companyName;
          previousValues.slug = promoter.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (promoter as Record<string, unknown>)[mapping.column];
        }
      }

      await db.update(promoters).set(updates).where(eq(promoters.id, promoter.id));

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
            promoter: { id: promoter.id, companyName: updates.companyName ?? promoter.companyName },
            fieldsUpdated: requestedFields,
            previousValues,
            newValues,
          }),
        ],
      };
    }
  );

  // ── list_event_days ───────────────────────────────────────────
  server.tool(
    "list_event_days",
    "List the daily schedule for an event. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
    },
    async (params) => {
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const days = await db
        .select({
          id: eventDays.id,
          date: eventDays.date,
          openTime: eventDays.openTime,
          closeTime: eventDays.closeTime,
          notes: eventDays.notes,
          closed: eventDays.closed,
          vendorOnly: eventDays.vendorOnly,
        })
        .from(eventDays)
        .where(eq(eventDays.eventId, params.event_id));

      return {
        content: [
          jsonContent({
            event: eventRows[0].name,
            count: days.length,
            days,
          }),
        ],
      };
    }
  );

  // ── create_event_day ──────────────────────────────────────────
  server.tool(
    "create_event_day",
    "Add a day to an event's schedule. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      date: z.string().describe("Date (YYYY-MM-DD)"),
      open_time: z.string().describe("Opening time (HH:MM)"),
      close_time: z.string().describe("Closing time (HH:MM)"),
      notes: z.string().optional().describe("Notes for this day"),
      vendor_only: z
        .boolean()
        .optional()
        .describe("Whether this is a vendor-only day (e.g., setup)"),
    },
    async (params) => {
      // Verify event exists
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const dayId = crypto.randomUUID();

      await db.insert(eventDays).values({
        id: dayId,
        eventId: params.event_id,
        date: params.date,
        openTime: params.open_time,
        closeTime: params.close_time,
        notes: params.notes ?? null,
        vendorOnly: params.vendor_only ?? false,
      });

      // Recompute public date range on parent event
      const allDays = await db
        .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
        .from(eventDays)
        .where(eq(eventDays.eventId, params.event_id));
      const { publicStartDate, publicEndDate } = computePublicDates(allDays);
      await db
        .update(events)
        .set({ publicStartDate, publicEndDate, updatedAt: new Date() })
        .where(eq(events.id, params.event_id));

      return {
        content: [
          jsonContent({
            created: true,
            id: dayId,
            event: eventRows[0].name,
            date: params.date,
            openTime: params.open_time,
            closeTime: params.close_time,
            vendorOnly: params.vendor_only ?? false,
          }),
        ],
      };
    }
  );

  // ── update_event_day ──────────────────────────────────────────
  server.tool(
    "update_event_day",
    "Update an event day's schedule. Admin only.",
    {
      day_id: z.string().describe("Event day ID"),
      date: z.string().optional().describe("Date (YYYY-MM-DD)"),
      open_time: z.string().optional().describe("Opening time (HH:MM)"),
      close_time: z.string().optional().describe("Closing time (HH:MM)"),
      notes: z.string().optional().describe("Notes for this day"),
      closed: z.boolean().optional().describe("Whether this day is cancelled/closed"),
      vendor_only: z
        .boolean()
        .optional()
        .describe("Whether this is a vendor-only day (e.g., setup)"),
    },
    async (params) => {
      const dayRows = await db
        .select()
        .from(eventDays)
        .where(eq(eventDays.id, params.day_id))
        .limit(1);

      if (dayRows.length === 0) {
        return { content: [{ type: "text", text: "Event day not found." }], isError: true };
      }

      const updates: Record<string, unknown> = {};
      if (params.date !== undefined) updates.date = params.date;
      if (params.open_time !== undefined) updates.openTime = params.open_time;
      if (params.close_time !== undefined) updates.closeTime = params.close_time;
      if (params.notes !== undefined) updates.notes = params.notes;
      if (params.closed !== undefined) updates.closed = params.closed;
      if (params.vendor_only !== undefined) updates.vendorOnly = params.vendor_only;

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: "text", text: "No fields provided to update." }],
          isError: true,
        };
      }

      await db.update(eventDays).set(updates).where(eq(eventDays.id, params.day_id));

      // Recompute public date range on parent event
      const eventId = dayRows[0].eventId;
      const allDays = await db
        .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
        .from(eventDays)
        .where(eq(eventDays.eventId, eventId));
      const { publicStartDate, publicEndDate } = computePublicDates(allDays);
      await db
        .update(events)
        .set({ publicStartDate, publicEndDate, updatedAt: new Date() })
        .where(eq(events.id, eventId));

      return {
        content: [
          jsonContent({
            updated: true,
            id: params.day_id,
            fieldsUpdated: Object.keys(updates),
          }),
        ],
      };
    }
  );

  // ── delete_event_day ──────────────────────────────────────────
  server.tool(
    "delete_event_day",
    "Remove a day from an event's schedule. Admin only.",
    {
      day_id: z.string().describe("Event day ID"),
    },
    async (params) => {
      const dayRows = await db
        .select({ id: eventDays.id, date: eventDays.date, eventId: eventDays.eventId })
        .from(eventDays)
        .where(eq(eventDays.id, params.day_id))
        .limit(1);

      if (dayRows.length === 0) {
        return { content: [{ type: "text", text: "Event day not found." }], isError: true };
      }

      const eventId = dayRows[0].eventId;
      await db.delete(eventDays).where(eq(eventDays.id, params.day_id));

      // Recompute public date range on parent event
      const remainingDays = await db
        .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
        .from(eventDays)
        .where(eq(eventDays.eventId, eventId));
      const { publicStartDate, publicEndDate } = computePublicDates(remainingDays);
      await db
        .update(events)
        .set({ publicStartDate, publicEndDate, updatedAt: new Date() })
        .where(eq(events.id, eventId));

      return {
        content: [jsonContent({ deleted: true, id: params.day_id, date: dayRows[0].date })],
      };
    }
  );
}
