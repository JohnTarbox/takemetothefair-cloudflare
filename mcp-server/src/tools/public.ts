import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, gte, lte, like, inArray, sql } from "drizzle-orm";
import { events, venues, vendors, eventVendors, eventDays, promoters } from "../schema.js";
import {
  parseJsonArray,
  formatDateRange,
  formatPrice,
  escapeLike,
  fuzzyTokenScore,
  PUBLIC_EVENT_STATUSES,
  PUBLIC_VENDOR_STATUSES,
  jsonContent,
} from "../helpers.js";
import type { Db } from "../db.js";

export function registerPublicTools(server: McpServer, db: Db) {
  // ── search_events ──────────────────────────────────────────────
  server.tool(
    "search_events",
    "Search events by name, category, state, venue, city, promoter, or date range. Supports fuzzy name matching to find events even when names differ slightly. Use venue_id or promoter_id to list all events for a specific venue or promoter. Returns up to 20 results.",
    {
      query: z
        .string()
        .optional()
        .describe("Search by event name (partial match, or fuzzy when fuzzy=true)"),
      fuzzy: z
        .boolean()
        .optional()
        .describe(
          "Enable fuzzy name matching (default false). Returns results sorted by match_score."
        ),
      category: z.string().optional().describe("Filter by category"),
      state: z.string().optional().describe("Filter by venue state (2-letter code)"),
      venue_id: z
        .string()
        .optional()
        .describe("Filter by venue ID (UUID) — returns all events at a specific venue"),
      venue_name: z
        .string()
        .optional()
        .describe("Search by venue name (partial match). Ignored if venue_id is provided."),
      city: z.string().optional().describe("Filter by venue city (partial match)"),
      promoter_id: z
        .string()
        .optional()
        .describe("Filter by promoter ID (UUID) — returns all events by a specific promoter"),
      start_after: z.string().optional().describe("Events starting after this date (YYYY-MM-DD)"),
      start_before: z.string().optional().describe("Events starting before this date (YYYY-MM-DD)"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [inArray(events.status, [...PUBLIC_EVENT_STATUSES])];

      if (params.query && !params.fuzzy) {
        conditions.push(like(events.name, `%${escapeLike(params.query)}%`));
      }

      if (params.start_after) {
        conditions.push(gte(events.startDate, new Date(params.start_after)));
      }

      if (params.start_before) {
        conditions.push(lte(events.startDate, new Date(params.start_before)));
      }

      // Push state filter into SQL — venue is already joined
      if (params.state) {
        conditions.push(sql`upper(${venues.state}) = upper(${params.state})`);
      }

      if (params.venue_id) {
        conditions.push(eq(events.venueId, params.venue_id));
      }

      if (params.venue_name && !params.venue_id) {
        conditions.push(like(venues.name, `%${escapeLike(params.venue_name)}%`));
      }

      if (params.city) {
        conditions.push(like(venues.city, `%${escapeLike(params.city)}%`));
      }

      if (params.promoter_id) {
        conditions.push(eq(events.promoterId, params.promoter_id));
      }

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      // Over-fetch when post-processing is needed (category filter or fuzzy scoring)
      const needsOverfetch = params.category || params.fuzzy;
      const sqlLimit = needsOverfetch ? Math.max(limit * 10, 200) : limit;
      // Fuzzy reorders results, so SQL offset is meaningless — apply in JS instead
      const sqlOffset = params.fuzzy ? 0 : offset;

      const query = db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          status: events.status,
          categories: events.categories,
          imageUrl: events.imageUrl,
          ticketPriceMin: events.ticketPriceMinCents,
          ticketPriceMax: events.ticketPriceMaxCents,
          venueId: events.venueId,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
          promoterId: events.promoterId,
          promoterName: promoters.companyName,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(...conditions))
        .limit(sqlLimit)
        .offset(sqlOffset);

      const rows = await query;

      // Post-filter by category (stored as JSON, can't filter in SQL)
      let results = rows;
      if (params.category) {
        const cat = params.category.toLowerCase();
        results = results.filter((r) =>
          parseJsonArray(r.categories).some((c) => c.toLowerCase().includes(cat))
        );
      }

      // Fuzzy scoring: score, filter by threshold, sort by score, then paginate
      type Row = (typeof results)[number];
      type ScoredRow = Row & { matchScore?: number };
      let scored: ScoredRow[];
      if (params.fuzzy && params.query) {
        scored = results
          .map((r) => ({ ...r, matchScore: fuzzyTokenScore(params.query!, r.name) }))
          .filter((r) => r.matchScore! >= 0.2)
          .sort((a, b) => b.matchScore! - a.matchScore!)
          .slice(offset, offset + limit);
      } else {
        scored = params.fuzzy ? results.slice(offset, offset + limit) : results.slice(0, limit);
      }

      const output = scored.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        dates: formatDateRange(r.startDate, r.endDate),
        venue_id: r.venueId || null,
        location: [r.venueName, r.venueCity, r.venueState].filter(Boolean).join(", ") || "TBD",
        promoter_id: r.promoterId,
        promoter: r.promoterName || "Unknown",
        categories: parseJsonArray(r.categories),
        price: formatPrice(r.ticketPriceMin, r.ticketPriceMax),
        status: r.status,
        image_url: r.imageUrl || null,
        ...(r.matchScore != null ? { match_score: r.matchScore } : {}),
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

  // ── get_event_details ──────────────────────────────────────────
  server.tool(
    "get_event_details",
    "Get full details for an event by its slug, including venue, promoter, and vendor count.",
    {
      slug: z.string().describe("Event slug (URL-friendly name)"),
    },
    async ({ slug }) => {
      const rows = await db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          description: events.description,
          startDate: events.startDate,
          endDate: events.endDate,
          datesConfirmed: events.datesConfirmed,
          categories: events.categories,
          tags: events.tags,
          ticketUrl: events.ticketUrl,
          ticketPriceMin: events.ticketPriceMinCents,
          ticketPriceMax: events.ticketPriceMaxCents,
          imageUrl: events.imageUrl,
          status: events.status,
          commercialVendorsAllowed: events.commercialVendorsAllowed,
          venueId: events.venueId,
          venueName: venues.name,
          venueAddress: venues.address,
          venueCity: venues.city,
          venueState: venues.state,
          venueZip: venues.zip,
          promoterId: events.promoterId,
          promoterName: promoters.companyName,
          promoterSlug: promoters.slug,
          promoterWebsite: promoters.website,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(and(eq(events.slug, slug), inArray(events.status, [...PUBLIC_EVENT_STATUSES])))
        .limit(1);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const event = rows[0];

      // Count approved/confirmed vendors
      const vendorRows = await db
        .select({ id: eventVendors.id })
        .from(eventVendors)
        .where(
          and(
            eq(eventVendors.eventId, event.id),
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES])
          )
        );

      // Get event days
      const days = await db
        .select({
          date: eventDays.date,
          openTime: eventDays.openTime,
          closeTime: eventDays.closeTime,
          notes: eventDays.notes,
        })
        .from(eventDays)
        .where(eq(eventDays.eventId, event.id));

      return {
        content: [
          jsonContent({
            name: event.name,
            slug: event.slug,
            description: event.description,
            dates: formatDateRange(event.startDate, event.endDate),
            datesConfirmed: event.datesConfirmed,
            venue: event.venueName
              ? {
                  id: event.venueId,
                  name: event.venueName,
                  address: event.venueAddress,
                  city: event.venueCity,
                  state: event.venueState,
                  zip: event.venueZip,
                }
              : null,
            promoter: event.promoterName
              ? {
                  id: event.promoterId,
                  name: event.promoterName,
                  slug: event.promoterSlug,
                  website: event.promoterWebsite,
                }
              : null,
            categories: parseJsonArray(event.categories),
            tags: parseJsonArray(event.tags),
            price: formatPrice(event.ticketPriceMin, event.ticketPriceMax),
            ticketUrl: event.ticketUrl,
            imageUrl: event.imageUrl || null,
            commercialVendorsAllowed: event.commercialVendorsAllowed,
            vendorCount: vendorRows.length,
            status: event.status,
            schedule: days.length > 0 ? days : null,
          }),
        ],
      };
    }
  );

  // ── list_event_vendors ─────────────────────────────────────────
  server.tool(
    "list_event_vendors",
    "List vendors participating in an event (approved/confirmed only).",
    {
      event_slug: z.string().describe("Event slug"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      // Find event by slug
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(
          and(
            eq(events.slug, params.event_slug),
            inArray(events.status, [...PUBLIC_EVENT_STATUSES])
          )
        )
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const rows = await db
        .select({
          vendorId: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          vendorType: vendors.vendorType,
          products: vendors.products,
          description: vendors.description,
          boothInfo: eventVendors.boothInfo,
        })
        .from(eventVendors)
        .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .where(
          and(
            eq(eventVendors.eventId, eventRows[0].id),
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES])
          )
        )
        .limit(params.limit ?? 20)
        .offset(params.offset ?? 0);

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const output = rows.map((r) => ({
        id: r.vendorId,
        businessName: r.businessName,
        slug: r.slug,
        type: r.vendorType,
        products: parseJsonArray(r.products),
        description: r.description ? r.description.slice(0, 200) : null,
        boothInfo: r.boothInfo,
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

  // ── search_vendors ─────────────────────────────────────────────
  server.tool(
    "search_vendors",
    "Search vendors by name or type.",
    {
      query: z.string().optional().describe("Search by business name (partial match)"),
      type: z.string().optional().describe("Filter by vendor type"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [];

      if (params.query) {
        conditions.push(like(vendors.businessName, `%${escapeLike(params.query)}%`));
      }
      if (params.type) {
        conditions.push(like(vendors.vendorType, `%${escapeLike(params.type)}%`));
      }

      const rows = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          vendorType: vendors.vendorType,
          products: vendors.products,
          description: vendors.description,
          city: vendors.city,
          state: vendors.state,
        })
        .from(vendors)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .limit(params.limit ?? 20)
        .offset(params.offset ?? 0);

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const output = rows.map((r) => ({
        id: r.id,
        businessName: r.businessName,
        slug: r.slug,
        type: r.vendorType,
        products: parseJsonArray(r.products),
        description: r.description ? r.description.slice(0, 200) : null,
        location: [r.city, r.state].filter(Boolean).join(", ") || null,
      }));

      return {
        content: [
          jsonContent({
            count: output.length,
            offset,
            has_more: output.length === limit,
            vendors: output,
          }),
        ],
      };
    }
  );

  // ── search_venues ──────────────────────────────────────────────
  server.tool(
    "search_venues",
    "Search venues by name, city, or state.",
    {
      query: z.string().optional().describe("Search by venue name (partial match)"),
      city: z.string().optional().describe("Filter by city"),
      state: z.string().optional().describe("Filter by state (2-letter code)"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [eq(venues.status, "ACTIVE")];

      if (params.query) {
        conditions.push(like(venues.name, `%${escapeLike(params.query)}%`));
      }
      if (params.city) {
        conditions.push(like(venues.city, `%${escapeLike(params.city)}%`));
      }
      if (params.state) {
        conditions.push(sql`upper(${venues.state}) = upper(${params.state})`);
      }

      const rows = await db
        .select({
          id: venues.id,
          name: venues.name,
          slug: venues.slug,
          address: venues.address,
          city: venues.city,
          state: venues.state,
          zip: venues.zip,
          capacity: venues.capacity,
          description: venues.description,
          website: venues.website,
        })
        .from(venues)
        .where(and(...conditions))
        .limit(params.limit ?? 20)
        .offset(params.offset ?? 0);

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const output = rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        address: `${r.address}, ${r.city}, ${r.state} ${r.zip}`,
        capacity: r.capacity,
        description: r.description ? r.description.slice(0, 200) : null,
        website: r.website,
      }));

      return {
        content: [
          jsonContent({
            count: output.length,
            offset,
            has_more: output.length === limit,
            venues: output,
          }),
        ],
      };
    }
  );

  // ── get_venue_details ─────────────────────────────────────────
  server.tool(
    "get_venue_details",
    "Get full details for a venue by slug or ID, including upcoming event count.",
    {
      slug: z.string().optional().describe("Venue slug (URL-friendly name)"),
      id: z.string().optional().describe("Venue ID (UUID)"),
    },
    async (params) => {
      if (!params.slug && !params.id) {
        return {
          content: [{ type: "text", text: "Provide either slug or id to look up a venue." }],
          isError: true,
        };
      }

      const condition = params.id ? eq(venues.id, params.id) : eq(venues.slug, params.slug!);

      const rows = await db
        .select({
          id: venues.id,
          name: venues.name,
          slug: venues.slug,
          address: venues.address,
          city: venues.city,
          state: venues.state,
          zip: venues.zip,
          latitude: venues.latitude,
          longitude: venues.longitude,
          capacity: venues.capacity,
          amenities: venues.amenities,
          contactEmail: venues.contactEmail,
          contactPhone: venues.contactPhone,
          website: venues.website,
          description: venues.description,
          imageUrl: venues.imageUrl,
          googleMapsUrl: venues.googleMapsUrl,
          googleRating: venues.googleRating,
          status: venues.status,
          createdAt: venues.createdAt,
        })
        .from(venues)
        .where(condition)
        .limit(1);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "Venue not found." }], isError: true };
      }

      const venue = rows[0];

      // Count upcoming events at this venue
      const upcomingEvents = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.venueId, venue.id),
            inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
            gte(events.endDate, new Date())
          )
        );

      return {
        content: [
          jsonContent({
            id: venue.id,
            name: venue.name,
            slug: venue.slug,
            address: venue.address,
            city: venue.city,
            state: venue.state,
            zip: venue.zip,
            latitude: venue.latitude,
            longitude: venue.longitude,
            capacity: venue.capacity,
            amenities: parseJsonArray(venue.amenities),
            contactEmail: venue.contactEmail,
            contactPhone: venue.contactPhone,
            website: venue.website,
            description: venue.description,
            imageUrl: venue.imageUrl || null,
            googleMapsUrl: venue.googleMapsUrl,
            googleRating: venue.googleRating,
            status: venue.status,
            upcomingEventCount: upcomingEvents.length,
          }),
        ],
      };
    }
  );

  // ── get_vendor_details ────────────────────────────────────────
  server.tool(
    "get_vendor_details",
    "Get full details for a vendor by slug or ID, including count of upcoming confirmed events.",
    {
      slug: z.string().optional().describe("Vendor slug (URL-friendly name)"),
      id: z.string().optional().describe("Vendor ID (UUID)"),
    },
    async (params) => {
      if (!params.slug && !params.id) {
        return {
          content: [{ type: "text", text: "Provide either slug or id to look up a vendor." }],
          isError: true,
        };
      }

      const condition = params.id ? eq(vendors.id, params.id) : eq(vendors.slug, params.slug!);

      const rows = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          description: vendors.description,
          vendorType: vendors.vendorType,
          products: vendors.products,
          website: vendors.website,
          logoUrl: vendors.logoUrl,
          verified: vendors.verified,
          commercial: vendors.commercial,
          contactName: vendors.contactName,
          contactEmail: vendors.contactEmail,
          contactPhone: vendors.contactPhone,
          city: vendors.city,
          state: vendors.state,
          createdAt: vendors.createdAt,
        })
        .from(vendors)
        .where(condition)
        .limit(1);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
      }

      const vendor = rows[0];

      // Count upcoming confirmed events for this vendor
      const confirmedEvents = await db
        .select({ id: eventVendors.id })
        .from(eventVendors)
        .innerJoin(events, eq(eventVendors.eventId, events.id))
        .where(
          and(
            eq(eventVendors.vendorId, vendor.id),
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
            inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
            gte(events.endDate, new Date())
          )
        );

      return {
        content: [
          jsonContent({
            id: vendor.id,
            businessName: vendor.businessName,
            slug: vendor.slug,
            description: vendor.description,
            vendorType: vendor.vendorType,
            products: parseJsonArray(vendor.products),
            website: vendor.website,
            logoUrl: vendor.logoUrl || null,
            verified: vendor.verified,
            commercial: vendor.commercial,
            contactName: vendor.contactName,
            contactEmail: vendor.contactEmail,
            contactPhone: vendor.contactPhone,
            city: vendor.city,
            state: vendor.state,
            upcomingEventCount: confirmedEvents.length,
          }),
        ],
      };
    }
  );

  // ── get_promoter_details ──────────────────────────────────────
  server.tool(
    "get_promoter_details",
    "Get full details for an event promoter by slug or ID, including count of upcoming public events.",
    {
      slug: z.string().optional().describe("Promoter slug (URL-friendly name)"),
      id: z.string().optional().describe("Promoter ID (UUID)"),
    },
    async (params) => {
      if (!params.slug && !params.id) {
        return {
          content: [{ type: "text", text: "Provide either slug or id to look up a promoter." }],
          isError: true,
        };
      }

      const condition = params.id ? eq(promoters.id, params.id) : eq(promoters.slug, params.slug!);

      const rows = await db
        .select({
          id: promoters.id,
          companyName: promoters.companyName,
          slug: promoters.slug,
          description: promoters.description,
          website: promoters.website,
          socialLinks: promoters.socialLinks,
          logoUrl: promoters.logoUrl,
          verified: promoters.verified,
          createdAt: promoters.createdAt,
        })
        .from(promoters)
        .where(condition)
        .limit(1);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "Promoter not found." }], isError: true };
      }

      const promoter = rows[0];

      // Count upcoming public events by this promoter
      const upcomingEvents = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.promoterId, promoter.id),
            inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
            gte(events.endDate, new Date())
          )
        );

      return {
        content: [
          jsonContent({
            id: promoter.id,
            companyName: promoter.companyName,
            slug: promoter.slug,
            description: promoter.description,
            website: promoter.website,
            socialLinks: promoter.socialLinks,
            logoUrl: promoter.logoUrl || null,
            verified: promoter.verified,
            upcomingEventCount: upcomingEvents.length,
          }),
        ],
      };
    }
  );

  // ── search_promoters ──────────────────────────────────────────
  server.tool(
    "search_promoters",
    "Search event promoters by name.",
    {
      query: z.string().optional().describe("Search by promoter/company name (partial match)"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [];

      if (params.query) {
        conditions.push(like(promoters.companyName, `%${escapeLike(params.query)}%`));
      }

      const rows = await db
        .select({
          id: promoters.id,
          companyName: promoters.companyName,
          slug: promoters.slug,
          description: promoters.description,
          website: promoters.website,
          verified: promoters.verified,
        })
        .from(promoters)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .limit(params.limit ?? 20)
        .offset(params.offset ?? 0);

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const output = rows.map((r) => ({
        id: r.id,
        companyName: r.companyName,
        slug: r.slug,
        description: r.description ? r.description.slice(0, 200) : null,
        website: r.website,
        verified: r.verified,
      }));

      return {
        content: [
          jsonContent({
            count: output.length,
            offset,
            has_more: output.length === limit,
            promoters: output,
          }),
        ],
      };
    }
  );
}
