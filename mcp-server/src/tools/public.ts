import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, gte, lte, like, inArray } from "drizzle-orm";
import { events, venues, vendors, eventVendors, eventDays } from "../schema.js";
import {
  parseJsonArray,
  formatDateRange,
  formatPrice,
  escapeLike,
  PUBLIC_EVENT_STATUSES,
  PUBLIC_VENDOR_STATUSES,
  jsonContent,
} from "../helpers.js";
import type { Db } from "../db.js";

export function registerPublicTools(server: McpServer, db: Db) {
  // ── search_events ──────────────────────────────────────────────
  server.tool(
    "search_events",
    "Search events by name, category, state, or date range. Returns up to 20 results.",
    {
      query: z.string().optional().describe("Search by event name (partial match)"),
      category: z.string().optional().describe("Filter by category"),
      state: z.string().optional().describe("Filter by venue state (2-letter code)"),
      start_after: z.string().optional().describe("Events starting after this date (YYYY-MM-DD)"),
      start_before: z.string().optional().describe("Events starting before this date (YYYY-MM-DD)"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
    },
    async (params) => {
      const conditions = [
        inArray(events.status, [...PUBLIC_EVENT_STATUSES]),
      ];

      if (params.query) {
        conditions.push(like(events.name, `%${escapeLike(params.query)}%`));
      }

      if (params.start_after) {
        conditions.push(gte(events.startDate, new Date(params.start_after)));
      }

      if (params.start_before) {
        conditions.push(lte(events.startDate, new Date(params.start_before)));
      }

      let query = db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          status: events.status,
          categories: events.categories,
          imageUrl: events.imageUrl,
          ticketPriceMin: events.ticketPriceMin,
          ticketPriceMax: events.ticketPriceMax,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .where(and(...conditions))
        .limit(params.limit ?? 20);

      const rows = await query;

      // Post-filter by category/state (since these are on joined tables or JSON)
      let results = rows;
      if (params.category) {
        const cat = params.category.toLowerCase();
        results = results.filter((r) =>
          parseJsonArray(r.categories).some((c) => c.toLowerCase().includes(cat)),
        );
      }
      if (params.state) {
        const st = params.state.toUpperCase();
        results = results.filter((r) => r.venueState?.toUpperCase() === st);
      }

      const output = results.map((r) => ({
        name: r.name,
        slug: r.slug,
        dates: formatDateRange(r.startDate, r.endDate),
        location: [r.venueName, r.venueCity, r.venueState].filter(Boolean).join(", ") || "TBD",
        categories: parseJsonArray(r.categories),
        price: formatPrice(r.ticketPriceMin, r.ticketPriceMax),
        status: r.status,
      }));

      return { content: [jsonContent({ count: output.length, events: output })] };
    },
  );

  // ── get_event_details ──────────────────────────────────────────
  server.tool(
    "get_event_details",
    "Get full details for an event by its slug, including venue info and vendor count.",
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
          ticketPriceMin: events.ticketPriceMin,
          ticketPriceMax: events.ticketPriceMax,
          imageUrl: events.imageUrl,
          status: events.status,
          commercialVendorsAllowed: events.commercialVendorsAllowed,
          venueName: venues.name,
          venueAddress: venues.address,
          venueCity: venues.city,
          venueState: venues.state,
          venueZip: venues.zip,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
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
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
          ),
        );

      // Get event days
      const days = await db
        .select({ date: eventDays.date, openTime: eventDays.openTime, closeTime: eventDays.closeTime, notes: eventDays.notes })
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
                  name: event.venueName,
                  address: event.venueAddress,
                  city: event.venueCity,
                  state: event.venueState,
                  zip: event.venueZip,
                }
              : null,
            categories: parseJsonArray(event.categories),
            tags: parseJsonArray(event.tags),
            price: formatPrice(event.ticketPriceMin, event.ticketPriceMax),
            ticketUrl: event.ticketUrl,
            commercialVendorsAllowed: event.commercialVendorsAllowed,
            vendorCount: vendorRows.length,
            status: event.status,
            schedule: days.length > 0 ? days : null,
          }),
        ],
      };
    },
  );

  // ── list_event_vendors ─────────────────────────────────────────
  server.tool(
    "list_event_vendors",
    "List vendors participating in an event (approved/confirmed only).",
    {
      event_slug: z.string().describe("Event slug"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
    },
    async (params) => {
      // Find event by slug
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(and(eq(events.slug, params.event_slug), inArray(events.status, [...PUBLIC_EVENT_STATUSES])))
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const rows = await db
        .select({
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
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
          ),
        )
        .limit(params.limit ?? 20);

      const output = rows.map((r) => ({
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
            vendors: output,
          }),
        ],
      };
    },
  );

  // ── search_vendors ─────────────────────────────────────────────
  server.tool(
    "search_vendors",
    "Search vendors by name or type.",
    {
      query: z.string().optional().describe("Search by business name (partial match)"),
      type: z.string().optional().describe("Filter by vendor type"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
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
        .limit(params.limit ?? 20);

      const output = rows.map((r) => ({
        businessName: r.businessName,
        slug: r.slug,
        type: r.vendorType,
        products: parseJsonArray(r.products),
        description: r.description ? r.description.slice(0, 200) : null,
        location: [r.city, r.state].filter(Boolean).join(", ") || null,
      }));

      return { content: [jsonContent({ count: output.length, vendors: output })] };
    },
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
        conditions.push(eq(venues.state, params.state.toUpperCase()));
      }

      const rows = await db
        .select({
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
        .limit(params.limit ?? 20);

      const output = rows.map((r) => ({
        name: r.name,
        slug: r.slug,
        address: `${r.address}, ${r.city}, ${r.state} ${r.zip}`,
        capacity: r.capacity,
        description: r.description ? r.description.slice(0, 200) : null,
        website: r.website,
      }));

      return { content: [jsonContent({ count: output.length, venues: output })] };
    },
  );
}
