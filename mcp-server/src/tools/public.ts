import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, or, gte, lte, like, inArray, sql } from "drizzle-orm";
import { events, venues, vendors, eventVendors, eventDays, promoters } from "../schema.js";
import { PRIMARY_AUDIENCE, PUBLIC_ACCESS } from "@takemetothefair/constants";
import {
  parseJsonArray,
  formatDateRange,
  formatPrice,
  escapeLike,
  fuzzyTokenScore,
  tokenize,
  PUBLIC_VENDOR_STATUSES,
  publicEventWhere,
  jsonContent,
  unsafeSlug,
} from "../helpers.js";
import {
  displayVendorName,
  type ParentDisplayInput,
  type VendorDisplayInput,
} from "@takemetothefair/utils";
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
      // TAX1 Phase 1 (2026-06-02) — audience / access filters.
      // Defaults aren't applied here; omitting either param skips
      // the filter so existing callers see no behavior change.
      primary_audience: z
        .enum(PRIMARY_AUDIENCE)
        .optional()
        .describe(
          "Filter by audience orientation. PUBLIC = general public; TRADE = industry / B2B; MEMBERS = association / club."
        ),
      public_access: z
        .enum(PUBLIC_ACCESS)
        .optional()
        .describe(
          "Filter by public-access policy. OPEN = anyone can attend (may still require ticket); CLOSED = restricted."
        ),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [publicEventWhere()];

      if (params.query && !params.fuzzy) {
        conditions.push(like(events.name, `%${escapeLike(params.query)}%`));
      } else if (params.query && params.fuzzy) {
        // Fuzzy mode: pre-filter the SQL candidate set to rows whose name
        // contains AT LEAST ONE non-stopword query token. Without this gate,
        // the JS-side scorer only sees the first 200 (sqlLimit) rows of the
        // PUBLIC_EVENT_STATUSES set in arbitrary scan order — a matching event
        // past row 200 is silently invisible. The 2026-05-06 memo documented 7
        // false negatives caused by this exact gap (e.g.
        // search({query:"Yankee Homecoming",fuzzy:true}) returning 0 results
        // even though "Yankee Homecoming 2026" exists).
        //
        // Tokens are extracted with the same rules as fuzzyTokenScore (stop
        // words, year suffixes, ordinals stripped) so the SQL filter and JS
        // scorer agree on what a "token" is. If every word in the query is a
        // stop word / year / ordinal, no SQL filter is applied — the JS
        // scorer would return 0 matches anyway, so the over-fetch slice
        // doesn't hurt.
        const tokens = tokenize(params.query);
        if (tokens.length > 0) {
          const tokenLikes = tokens.map((t) => like(events.name, `%${escapeLike(t)}%`));
          // OR — match any token. The JS scorer then ranks by fraction of
          // tokens that match.
          const fuzzyOr = tokenLikes.length === 1 ? tokenLikes[0] : or(...tokenLikes);
          if (fuzzyOr) conditions.push(fuzzyOr);
        }
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

      // TAX1 Phase 1 — pure column equality, both columns are
      // NOT NULL DEFAULT so they're always present and indexable.
      if (params.primary_audience) {
        conditions.push(eq(events.primaryAudience, params.primary_audience));
      }
      if (params.public_access) {
        conditions.push(eq(events.publicAccess, params.public_access));
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
        .where(and(eq(events.slug, unsafeSlug(slug)), publicEventWhere()))
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
    "List vendors participating in an event (approved/confirmed only). Pass either event_id or event_slug — adjacent tools (get_event_lifecycle_history, list_event_citations, update_event_status) key on event_id, so accepting both keeps the MCP surface consistent. K18 Phase 1: each link returns its `event_day_id` + resolved date when scoped to a specific occurrence; series-wide links have `event_day_id: null`. Optional `event_day_id` filter narrows results to one occurrence.",
    {
      // K6 (analyst, 2026-05-31): accept event_id OR event_slug to match the
      // rest of the event-tool surface. One must be provided; if both are,
      // event_id wins. Avoids a forced slug round-trip mid-workflow.
      event_id: z.string().min(1).optional().describe("Event ID (UUID or legacy hex)."),
      event_slug: z.string().min(1).optional().describe("Event slug."),
      // K18 Phase 1 — optional per-occurrence filter. When set, returns only
      // links matching that specific event_day; when omitted, returns ALL
      // links (series-wide + per-day) so the UI can group by date itself.
      event_day_id: z
        .string()
        .optional()
        .describe(
          "K18 Phase 1: filter to vendors on this specific occurrence only. Omit for all links (series-wide + per-day)."
        ),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      if (!params.event_id && !params.event_slug) {
        return {
          content: [{ type: "text", text: "event_id or event_slug is required." }],
          isError: true,
        };
      }

      // Resolve event row. event_id wins over slug; both branches still gate on
      // publicEventWhere() so this tool never leaks pending/rejected events.
      const eventRows = params.event_id
        ? await db
            .select({ id: events.id, name: events.name })
            .from(events)
            .where(and(eq(events.id, params.event_id), publicEventWhere()))
            .limit(1)
        : await db
            .select({ id: events.id, name: events.name })
            .from(events)
            .where(and(eq(events.slug, unsafeSlug(params.event_slug!)), publicEventWhere()))
            .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      // K18 Phase 1: LEFT JOIN event_days to surface the resolved date
      // string alongside the eventDayId. NULL eventDayId → NULL date
      // (series-wide). Filter by eventDayId when the caller pinned one.
      const eventDayFilter = params.event_day_id
        ? eq(eventVendors.eventDayId, params.event_day_id)
        : undefined;
      const rows = await db
        .select({
          vendorId: vendors.id,
          businessName: vendors.businessName,
          // EH2.1 — surface display_name override; full brand-parent gate
          // resolution is deferred for list-returning tools (consumers
          // can call get_vendor_details when they need the gate).
          displayName: vendors.displayName,
          slug: vendors.slug,
          vendorType: vendors.vendorType,
          products: vendors.products,
          description: vendors.description,
          boothInfo: eventVendors.boothInfo,
          eventDayId: eventVendors.eventDayId,
          eventDayDate: eventDays.date,
        })
        .from(eventVendors)
        .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .leftJoin(eventDays, eq(eventVendors.eventDayId, eventDays.id))
        .where(
          and(
            eq(eventVendors.eventId, eventRows[0].id),
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
            ...(eventDayFilter ? [eventDayFilter] : [])
          )
        )
        .orderBy(sql`${vendors.businessName} COLLATE NOCASE`)
        .limit(params.limit ?? 20)
        .offset(params.offset ?? 0);

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const output = rows.map((r) => ({
        id: r.vendorId,
        businessName: r.businessName,
        // EH2.1 — computed surface name. display_name override applied;
        // INDEPENDENT vendors get businessName unchanged so consumers that
        // key on this field stay stable for ~99% of rows.
        display_name: r.displayName ?? r.businessName,
        slug: r.slug,
        type: r.vendorType,
        products: parseJsonArray(r.products),
        description: r.description ? r.description.slice(0, 200) : null,
        boothInfo: r.boothInfo,
        event_day_id: r.eventDayId,
        event_day_date: r.eventDayDate, // YYYY-MM-DD or null for series-wide
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
        // EH2.1 — match on either business_name OR display_name so a query
        // for the brand surface ("LeafFilter") finds the office row whose
        // only-the-override stores that surface ("LeafFilter North LLC").
        const q = `%${escapeLike(params.query)}%`;
        conditions.push(
          or(
            like(vendors.businessName, q),
            sql`${vendors.displayName} IS NOT NULL AND ${like(vendors.displayName, q)}`
          )!
        );
      }
      if (params.type) {
        conditions.push(like(vendors.vendorType, `%${escapeLike(params.type)}%`));
      }

      const rows = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          // EH2.1 — display_name override surfaced on every search result.
          displayName: vendors.displayName,
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
        // EH2.1 — computed surface name (display_name override applied).
        // Full brand-parent gate resolution lives on get_vendor_details;
        // search returns the row-level surface so a brand search returns
        // each office row that matches.
        display_name: r.displayName ?? r.businessName,
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

      const condition = params.id
        ? eq(venues.id, params.id)
        : eq(venues.slug, unsafeSlug(params.slug!));

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
          and(eq(events.venueId, venue.id), publicEventWhere(), gte(events.endDate, new Date()))
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

      const condition = params.id
        ? eq(vendors.id, params.id)
        : eq(vendors.slug, unsafeSlug(params.slug!));

      const rows = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          // EH2.1 — display_name override (drizzle/0121).
          displayName: vendors.displayName,
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
          // EH1 hierarchy + relationship model (drizzle/0106 + 0107).
          // Surfaced here so operators can verify hierarchy state with a
          // single read instead of inferring from migration UPDATE filters.
          role: vendors.role,
          brandParentVendorId: vendors.brandParentVendorId,
          operatorParentVendorId: vendors.operatorParentVendorId,
          aliasOfVendorId: vendors.aliasOfVendorId,
          relationshipType: vendors.relationshipType,
          defaultChildDisplay: vendors.defaultChildDisplay,
          displayOverridePermitted: vendors.displayOverridePermitted,
          displayMode: vendors.displayMode,
        })
        .from(vendors)
        .where(condition)
        .limit(1);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
      }

      const vendor = rows[0];

      // EH1 bonus — resolve brand/operator parent in a single batch so a
      // single read shows the full hierarchy without a second roundtrip.
      // Skipped (single empty SELECT) when both parent ids are null. The
      // parent SELECT now includes display_name + default_child_display so
      // EH2.1's displayVendorName() can run the full gate resolution.
      const parentIds = [vendor.brandParentVendorId, vendor.operatorParentVendorId].filter(
        (id): id is string => typeof id === "string" && id.length > 0
      );
      const parents = parentIds.length
        ? await db
            .select({
              id: vendors.id,
              slug: vendors.slug,
              businessName: vendors.businessName,
              displayName: vendors.displayName,
              role: vendors.role,
              defaultChildDisplay: vendors.defaultChildDisplay,
            })
            .from(vendors)
            .where(inArray(vendors.id, parentIds))
        : [];
      const parentById = new Map(parents.map((p) => [p.id, p]));
      const brandParent = vendor.brandParentVendorId
        ? (parentById.get(vendor.brandParentVendorId) ?? null)
        : null;
      const operatorParent = vendor.operatorParentVendorId
        ? (parentById.get(vendor.operatorParentVendorId) ?? null)
        : null;

      // EH2.1 — full gate resolution. Composes resolveVendorDisplay's mode
      // (self / brand_parent / operator_parent / both) with display_name
      // override into a single resolved string, matching what the public
      // /vendors/[slug] page renders as the H1.
      const vendorInput: VendorDisplayInput = {
        role: vendor.role,
        brandParentVendorId: vendor.brandParentVendorId,
        operatorParentVendorId: vendor.operatorParentVendorId,
        aliasOfVendorId: vendor.aliasOfVendorId,
        displayOverridePermitted: vendor.displayOverridePermitted,
        displayMode: vendor.displayMode,
        businessName: vendor.businessName,
        displayName: vendor.displayName,
      };
      const brandParentInput: ParentDisplayInput | null = brandParent
        ? {
            id: brandParent.id,
            role: brandParent.role,
            defaultChildDisplay: brandParent.defaultChildDisplay,
            businessName: brandParent.businessName,
            displayName: brandParent.displayName,
          }
        : null;
      const operatorParentInput: ParentDisplayInput | null = operatorParent
        ? {
            id: operatorParent.id,
            role: operatorParent.role,
            defaultChildDisplay: operatorParent.defaultChildDisplay,
            businessName: operatorParent.businessName,
            displayName: operatorParent.displayName,
          }
        : null;
      const resolvedDisplayName = displayVendorName(
        vendorInput,
        brandParentInput,
        operatorParentInput
      );

      // Count upcoming confirmed events for this vendor
      const confirmedEvents = await db
        .select({ id: eventVendors.id })
        .from(eventVendors)
        .innerJoin(events, eq(eventVendors.eventId, events.id))
        .where(
          and(
            eq(eventVendors.vendorId, vendor.id),
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
            publicEventWhere(),
            gte(events.endDate, new Date())
          )
        );

      return {
        content: [
          jsonContent({
            id: vendor.id,
            businessName: vendor.businessName,
            // EH2.1 — display_name override + computed surface name.
            // `display_name` is the resolved string honoring the full
            // hierarchy gate (matches /vendors/<slug> H1).
            displayName: vendor.displayName,
            display_name: resolvedDisplayName,
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
            // EH1 hierarchy (raw column values + resolved parent objects)
            role: vendor.role,
            brandParentVendorId: vendor.brandParentVendorId,
            operatorParentVendorId: vendor.operatorParentVendorId,
            aliasOfVendorId: vendor.aliasOfVendorId,
            relationshipType: vendor.relationshipType,
            defaultChildDisplay: vendor.defaultChildDisplay,
            displayOverridePermitted: vendor.displayOverridePermitted,
            displayMode: vendor.displayMode,
            brandParent,
            operatorParent,
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

      const condition = params.id
        ? eq(promoters.id, params.id)
        : eq(promoters.slug, unsafeSlug(params.slug!));

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
            publicEventWhere(),
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

  // ── get_vendor_events ──────────────────────────────────────────
  // K24 (2026-06-16): the reverse of list_event_vendors. The forward
  // direction (event → vendors) existed; the vendor → events traversal
  // previously required search_events + manual filtering or hand-walking
  // event_vendors. Same gating posture as the other public reads:
  //   - publicEventWhere() so PENDING/REJECTED *events* never leak, and
  //   - PUBLIC_VENDOR_STATUSES so a vendor's private application state
  //     (APPLIED / WAITLISTED / REJECTED links) is never surfaced — the
  //     returned application_status is therefore always APPROVED/CONFIRMED.
  server.tool(
    "get_vendor_events",
    "List the public events a vendor is linked to, with this vendor's per-event application status + participation type. Reverse of list_event_vendors. Gated like the other public reads: PENDING/REJECTED events never leak, and only public link statuses (APPROVED/CONFIRMED) are surfaced. Optional since/until (YYYY-MM-DD) bound by date overlap. A series event the vendor joins both series-wide and per-occurrence can appear more than once (distinguished by event_day_id).",
    {
      vendor_id: z.string().min(1).describe("Vendor ID (UUID or legacy hex)."),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Lower date bound (YYYY-MM-DD): include events ending on/after this date."),
      until: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Upper date bound (YYYY-MM-DD): include events starting on/before this date."),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      // Distinguish "no such vendor" (404) from "vendor with zero public
      // links" (empty list) — they mean different things to the caller.
      const vendorRows = await db
        .select({ id: vendors.id, businessName: vendors.businessName })
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);
      if (vendorRows.length === 0) {
        return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
      }

      // Date-overlap bounds. since → event hasn't ended before `since`;
      // until → event starts on/before `until`. Bad parses are ignored
      // rather than failing the call.
      const dateConds = [];
      if (params.since) {
        const since = new Date(`${params.since}T00:00:00Z`);
        if (!isNaN(since.getTime())) dateConds.push(gte(events.endDate, since));
      }
      if (params.until) {
        const until = new Date(`${params.until}T23:59:59Z`);
        if (!isNaN(until.getTime())) dateConds.push(lte(events.startDate, until));
      }

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const rows = await db
        .select({
          eventId: events.id,
          eventName: events.name,
          eventSlug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          status: eventVendors.status,
          participationType: eventVendors.participationType,
          eventDayId: eventVendors.eventDayId,
          eventDayDate: eventDays.date,
        })
        .from(eventVendors)
        .innerJoin(events, eq(eventVendors.eventId, events.id))
        .leftJoin(eventDays, eq(eventVendors.eventDayId, eventDays.id))
        .where(
          and(
            eq(eventVendors.vendorId, vendorRows[0].id),
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
            publicEventWhere(),
            ...dateConds
          )
        )
        .orderBy(sql`${events.startDate} ASC`)
        .limit(limit)
        .offset(offset);

      const output = rows.map((r) => ({
        event_id: r.eventId,
        event_name: r.eventName,
        event_slug: r.eventSlug,
        dates: formatDateRange(r.startDate, r.endDate),
        application_status: r.status,
        participation_type: r.participationType,
        // K18 per-occurrence parity with list_event_vendors: null = series-wide.
        event_day_id: r.eventDayId,
        event_day_date: r.eventDayDate,
      }));

      return {
        content: [
          jsonContent({
            vendor: vendorRows[0].businessName,
            count: output.length,
            offset,
            has_more: output.length === limit,
            events: output,
          }),
        ],
      };
    }
  );
}
