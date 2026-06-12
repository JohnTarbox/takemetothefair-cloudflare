import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, or, sql } from "drizzle-orm";
import { vendors, events, eventVendors, promoters, venues } from "../schema.js";
import {
  parseJsonArray,
  formatDateRange,
  jsonContent,
  sanitizeProse,
  publicUrlFor,
  triggerIndexNow,
  recomputeVendorCompleteness,
  logEnrichment,
  createSlug,
  appendSlugSegment,
  unsafeSlug,
  coerceVenueNameAtIngest,
} from "../helpers.js";
import { checkDuplicateViaMainApp } from "../duplicates/check-duplicate.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { gateUrlOnce, loadClassifications, shouldIngestFromSource } from "../url-classification.js";
import { evaluateGates, classifySource } from "@takemetothefair/utils";
import { EVENT_CATEGORIES, PRIMARY_AUDIENCE, PUBLIC_ACCESS } from "@takemetothefair/constants";
import { logError } from "../logger.js";

const COMMUNITY_PROMOTER_ID = "system-community-suggestions";

type IndexNowEnv = { MAIN_APP_URL?: string; INTERNAL_API_KEY?: string };

export function registerVendorTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: IndexNowEnv
) {
  // suggest_event only needs userId, not a vendor profile — register it first
  console.log(
    `[VENDOR-TOOLS] Registering suggest_event for userId=${auth.userId} role=${auth.role} vendorId=${auth.vendorId || "none"}`
  );
  registerSuggestEvent(server, db, auth, env);

  if (!auth.vendorId) {
    console.log(`[VENDOR-TOOLS] No vendorId — skipping profile/application tools`);
    return;
  }

  const vendorId = auth.vendorId;

  // ── get_my_vendor_profile ──────────────────────────────────────
  server.tool("get_my_vendor_profile", "Get your vendor profile details.", {}, async () => {
    const rows = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);

    if (rows.length === 0) {
      return { content: [{ type: "text", text: "Vendor profile not found." }], isError: true };
    }

    const v = rows[0];
    return {
      content: [
        jsonContent({
          id: v.id,
          businessName: v.businessName,
          slug: v.slug,
          description: v.description,
          vendorType: v.vendorType,
          products: parseJsonArray(v.products),
          website: v.website,
          commercial: v.commercial,
          verified: v.verified,
          contactName: v.contactName,
          contactEmail: v.contactEmail,
          contactPhone: v.contactPhone,
          city: v.city,
          state: v.state,
          latitude: v.latitude,
          longitude: v.longitude,
        }),
      ],
    };
  });

  // ── update_vendor_profile ──────────────────────────────────────
  server.tool(
    "update_vendor_profile",
    "Update your vendor profile fields. Only provided fields are updated.",
    {
      description: z.string().transform(sanitizeProse).optional().describe("Business description"),
      vendor_type: z
        .string()
        .transform(sanitizeProse)
        .optional()
        .describe("Type of vendor (e.g., Food, Crafts)"),
      products: z
        .array(z.string().transform(sanitizeProse))
        .optional()
        .describe("List of products/services"),
      website: z.string().optional().describe("Website URL"),
      contact_name: z.string().optional().describe("Contact person name"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      latitude: z.number().optional().describe("Home base latitude"),
      longitude: z.number().optional().describe("Home base longitude"),
    },
    async (params) => {
      const updates: Record<string, unknown> = {};
      if (params.description !== undefined) updates.description = params.description;
      if (params.vendor_type !== undefined) updates.vendorType = params.vendor_type;
      if (params.products !== undefined) updates.products = JSON.stringify(params.products);
      if (params.website !== undefined) updates.website = params.website;
      if (params.contact_name !== undefined) updates.contactName = params.contact_name;
      if (params.contact_email !== undefined) updates.contactEmail = params.contact_email;
      if (params.contact_phone !== undefined) updates.contactPhone = params.contact_phone;
      if (params.city !== undefined) updates.city = params.city;
      if (params.state !== undefined) updates.state = params.state;
      if (params.latitude !== undefined) updates.latitude = params.latitude;
      if (params.longitude !== undefined) updates.longitude = params.longitude;

      if (Object.keys(updates).length === 0) {
        return { content: [{ type: "text", text: "No fields to update." }], isError: true };
      }

      updates.updatedAt = new Date();

      await db.update(vendors).set(updates).where(eq(vendors.id, vendorId));

      await recomputeVendorCompleteness(db, vendorId);

      await logEnrichment(db, {
        targetType: "vendor",
        targetId: vendorId,
        source: "vendor_self",
        status: "success",
        fieldsChanged: Object.keys(updates).filter((k) => k !== "updatedAt"),
        actorUserId: auth.userId,
        notes: "MCP update_my_vendor",
      });

      return {
        content: [
          jsonContent({
            updated: true,
            fields: Object.keys(updates).filter((k) => k !== "updatedAt"),
          }),
        ],
      };
    }
  );

  // ── list_my_applications ───────────────────────────────────────
  server.tool(
    "list_my_applications",
    "List all your event applications with their status.",
    {
      status: z
        .enum([
          "INVITED",
          "INTERESTED",
          "APPLIED",
          "WAITLISTED",
          "APPROVED",
          "CONFIRMED",
          "REJECTED",
          "WITHDRAWN",
          "CANCELLED",
        ])
        .optional()
        .describe("Filter by application status"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [eq(eventVendors.vendorId, vendorId)];
      if (params.status) {
        conditions.push(eq(eventVendors.status, params.status));
      }

      const rows = await db
        .select({
          applicationId: eventVendors.id,
          eventId: eventVendors.eventId,
          status: eventVendors.status,
          paymentStatus: eventVendors.paymentStatus,
          boothInfo: eventVendors.boothInfo,
          eventName: events.name,
          eventSlug: events.slug,
          eventStartDate: events.startDate,
          eventEndDate: events.endDate,
          eventStatus: events.status,
        })
        .from(eventVendors)
        .innerJoin(events, eq(eventVendors.eventId, events.id))
        .where(and(...conditions))
        .limit(params.limit ?? 20)
        .offset(params.offset ?? 0);

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const output = rows.map((r) => ({
        applicationId: r.applicationId,
        status: r.status,
        paymentStatus: r.paymentStatus,
        boothInfo: r.boothInfo,
        event: {
          id: r.eventId,
          name: r.eventName,
          slug: r.eventSlug,
          dates: formatDateRange(r.eventStartDate, r.eventEndDate),
          status: r.eventStatus,
        },
      }));

      return {
        content: [
          jsonContent({
            count: output.length,
            offset,
            has_more: output.length === limit,
            applications: output,
          }),
        ],
      };
    }
  );

  // ── apply_to_event ─────────────────────────────────────────────
  server.tool(
    "apply_to_event",
    "Apply to participate in an event as a vendor.",
    {
      event_slug: z.string().describe("Slug of the event to apply to"),
      booth_info: z
        .string()
        .transform(sanitizeProse)
        .optional()
        .describe("Booth/space requirements or notes"),
    },
    async (params) => {
      // Find the event
      const eventRows = await db
        .select({
          id: events.id,
          name: events.name,
          status: events.status,
          commercialVendorsAllowed: events.commercialVendorsAllowed,
        })
        .from(events)
        .where(eq(events.slug, unsafeSlug(params.event_slug)))
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const event = eventRows[0];

      if (event.status !== "APPROVED" && event.status !== "TENTATIVE") {
        return {
          content: [
            { type: "text", text: "This event is not currently accepting vendor applications." },
          ],
          isError: true,
        };
      }

      // Check commercial vendor restriction
      const vendorRows = await db
        .select({ commercial: vendors.commercial, canSelfConfirm: vendors.canSelfConfirm })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .limit(1);

      if (vendorRows[0]?.commercial && !event.commercialVendorsAllowed) {
        return {
          content: [{ type: "text", text: "This event does not allow commercial vendors." }],
          isError: true,
        };
      }

      // Check for existing application
      const existing = await db
        .select({ id: eventVendors.id })
        .from(eventVendors)
        .where(and(eq(eventVendors.eventId, event.id), eq(eventVendors.vendorId, vendorId)))
        .limit(1);

      if (existing.length > 0) {
        return {
          content: [{ type: "text", text: "You have already applied to this event." }],
          isError: true,
        };
      }

      const autoConfirm = vendorRows[0]?.canSelfConfirm ?? false;
      const applicationId = crypto.randomUUID();

      await db.insert(eventVendors).values({
        id: applicationId,
        eventId: event.id,
        vendorId,
        boothInfo: params.booth_info || null,
        status: autoConfirm ? "CONFIRMED" : "APPLIED",
      });

      return {
        content: [
          jsonContent({
            applied: true,
            applicationId,
            event: event.name,
            status: autoConfirm ? "CONFIRMED" : "APPLIED",
          }),
        ],
      };
    }
  );

  // ── withdraw_application ───────────────────────────────────────
  server.tool(
    "withdraw_application",
    "Withdraw your application from an event.",
    {
      event_slug: z.string().describe("Slug of the event to withdraw from"),
    },
    async (params) => {
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.slug, unsafeSlug(params.event_slug)))
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const application = await db
        .select({ id: eventVendors.id, status: eventVendors.status })
        .from(eventVendors)
        .where(and(eq(eventVendors.eventId, eventRows[0].id), eq(eventVendors.vendorId, vendorId)))
        .limit(1);

      if (application.length === 0) {
        return {
          content: [{ type: "text", text: "No application found for this event." }],
          isError: true,
        };
      }

      const withdrawable = [
        "APPLIED",
        "APPROVED",
        "CONFIRMED",
        "WAITLISTED",
        "INTERESTED",
        "INVITED",
      ];
      if (!withdrawable.includes(application[0].status)) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot withdraw — application status is ${application[0].status}.`,
            },
          ],
          isError: true,
        };
      }

      await db
        .update(eventVendors)
        .set({ status: "WITHDRAWN" })
        .where(eq(eventVendors.id, application[0].id));

      return {
        content: [
          jsonContent({
            withdrawn: true,
            event: eventRows[0].name,
            previousStatus: application[0].status,
          }),
        ],
      };
    }
  );

  // ── check_date_conflicts ────────────────────────────────────────
  server.tool(
    "check_date_conflicts",
    "Check if an event's dates conflict with your existing applications. Optionally provide dates to check a hypothetical event. Also returns distance from your home base if coordinates are available.",
    {
      event_slug: z.string().optional().describe("Slug of an event to check against your schedule"),
      start_date: z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD) to check — used if event_slug is not provided"),
      end_date: z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD) to check — used if event_slug is not provided"),
    },
    async (params) => {
      // Resolve date range to check
      let checkStart: Date | null = null;
      let checkEnd: Date | null = null;
      let checkEventId: string | null = null;
      let checkEventName: string | null = null;
      let venueLat: number | null = null;
      let venueLng: number | null = null;

      if (params.event_slug) {
        const eventRows = await db
          .select({
            id: events.id,
            name: events.name,
            startDate: events.startDate,
            endDate: events.endDate,
            venueId: events.venueId,
          })
          .from(events)
          .where(eq(events.slug, unsafeSlug(params.event_slug)))
          .limit(1);

        if (eventRows.length === 0) {
          return { content: [{ type: "text", text: "Event not found." }], isError: true };
        }

        const evt = eventRows[0];
        checkStart = evt.startDate;
        checkEnd = evt.endDate;
        checkEventId = evt.id;
        checkEventName = evt.name;

        // Get venue coordinates for distance
        if (evt.venueId) {
          const venueRows = await db
            .select({ latitude: venues.latitude, longitude: venues.longitude })
            .from(venues)
            .where(eq(venues.id, evt.venueId))
            .limit(1);
          if (venueRows.length > 0) {
            venueLat = venueRows[0].latitude;
            venueLng = venueRows[0].longitude;
          }
        }
      } else if (params.start_date) {
        checkStart = new Date(params.start_date);
        if (isNaN(checkStart.getTime())) checkStart = null;
        if (params.end_date) {
          checkEnd = new Date(params.end_date);
          if (isNaN(checkEnd.getTime())) checkEnd = null;
        }
        checkEnd = checkEnd || checkStart;
      }

      if (!checkStart || !checkEnd) {
        return {
          content: [
            {
              type: "text",
              text: "Could not determine date range. Provide event_slug or start_date/end_date.",
            },
          ],
          isError: true,
        };
      }

      // Get vendor's active applications
      const apps = await db
        .select({
          eventId: eventVendors.eventId,
          status: eventVendors.status,
          eventName: events.name,
          eventSlug: events.slug,
          eventStartDate: events.startDate,
          eventEndDate: events.endDate,
        })
        .from(eventVendors)
        .innerJoin(events, eq(eventVendors.eventId, events.id))
        .where(eq(eventVendors.vendorId, vendorId));

      const activeStatuses = new Set([
        "INVITED",
        "INTERESTED",
        "APPLIED",
        "WAITLISTED",
        "APPROVED",
        "CONFIRMED",
      ]);

      const eStart = checkStart.getTime();
      const eEnd = checkEnd.getTime();

      const conflicts = apps
        .filter((a) => {
          if (checkEventId && a.eventId === checkEventId) return false;
          if (!activeStatuses.has(a.status)) return false;
          if (!a.eventStartDate || !a.eventEndDate) return false;
          const oStart = new Date(a.eventStartDate).getTime();
          const oEnd = new Date(a.eventEndDate).getTime();
          return eStart <= oEnd && eEnd >= oStart;
        })
        .map((a) => ({
          eventName: a.eventName,
          eventSlug: a.eventSlug,
          dates: formatDateRange(a.eventStartDate, a.eventEndDate),
          status: a.status,
        }));

      // Calculate distance if possible
      let distanceMiles: number | null = null;
      const vendorRows = await db
        .select({ latitude: vendors.latitude, longitude: vendors.longitude })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .limit(1);

      if (vendorRows[0]?.latitude && vendorRows[0]?.longitude && venueLat && venueLng) {
        const R = 3959; // Earth radius in miles
        const dLat = ((venueLat - vendorRows[0].latitude) * Math.PI) / 180;
        const dLon = ((venueLng - vendorRows[0].longitude) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((vendorRows[0].latitude * Math.PI) / 180) *
            Math.cos((venueLat * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
        distanceMiles = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
      }

      return {
        content: [
          jsonContent({
            event: checkEventName || `${params.start_date} to ${params.end_date}`,
            hasConflicts: conflicts.length > 0,
            conflictCount: conflicts.length,
            conflicts,
            ...(distanceMiles != null ? { distanceMiles } : {}),
          }),
        ],
      };
    }
  );
}

// ---------------------------------------------------------------------------
// suggest_event — registered separately since it only needs userId, not vendorId
// ---------------------------------------------------------------------------
function registerSuggestEvent(server: McpServer, db: Db, auth: AuthContext, env?: IndexNowEnv) {
  server.tool(
    "suggest_event",
    "Suggest a new event to be added to the platform. The event will be created with TENTATIVE status. `start_date` is required so duplicate-detection (which keys on venue + date) can run — without a date the dedup guard silently skipped and we accrued duplicate rows like 'Winthrop Arts Festival 2026' alongside '38th Annual Winthrop Arts Festival' on the same date. If the date is genuinely unknown, hold the submission until it's confirmed rather than creating a dateless row.",
    {
      name: z.string().transform(sanitizeProse).describe("Event name"),
      description: z.string().transform(sanitizeProse).optional().describe("Event description"),
      // A2 (2026-06-04): start_date is now REQUIRED. Previously optional;
      // when callers omitted it the dedup guard at L805
      // (`if (venueId && startDate && !params.force_create)`) silently
      // skipped, allowing duplicate rows at the same place. force_create
      // remains as the explicit escape hatch.
      start_date: z
        .string()
        .min(1, "start_date is required for duplicate-detection")
        .describe("Start date (YYYY-MM-DD) — required so dedup can match on venue + date"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      venue_name: z.string().transform(sanitizeProse).optional().describe("Venue name"),
      venue_city: z.string().optional().describe("Venue city"),
      venue_state: z.string().optional().describe("Venue state (2-letter code)"),
      // TAX1 A11 (2026-06-02) — let suggest_event accept categories at
      // create time. Before this PR every suggestion landed with the
      // hardcoded ["Event"] placeholder and needed manual recategorization
      // (5 Augusta Civic Center events on 6/2 all needed correcting).
      // When omitted, the insert still falls back to ["Event"] AND
      // emits a level:"info" log entry so /admin/source-quality can
      // surface uncategorized-suggestion frequency.
      categories: z
        .array(z.string())
        .optional()
        .describe(
          `Category list at creation time, e.g. ['Craft Fair','Festival']. Pick from: ${EVENT_CATEGORIES.join(", ")}. When omitted, the event lands as ["Event"] and surfaces in the admin uncategorized queue.`
        ),
      ticket_url: z.string().optional().describe("URL to purchase tickets"),
      source_url: z.string().optional().describe("URL with more information about the event"),
      // TAX1 Phase 1 (2026-06-02) — audience / access taxonomy. Both
      // default to the permissive value, so omitting both preserves
      // today's pre-TAX1 semantics. See drizzle/0100 + the events
      // schema header for the full design.
      primary_audience: z
        .enum(PRIMARY_AUDIENCE)
        .optional()
        .describe(
          "Who the event is ORIENTED toward. PUBLIC (default) = general public; TRADE = industry / B2B; MEMBERS = association / club. Orthogonal to public_access."
        ),
      public_access: z
        .enum(PUBLIC_ACCESS)
        .optional()
        .describe(
          "Can a non-member of the public attend at all? OPEN (default) = yes (may still require ticket); CLOSED = no. A TRADE+OPEN event means the public can pay in (e.g. industry expo)."
        ),
      access_notes: z
        .string()
        .max(1000)
        .transform(sanitizeProse)
        .optional()
        .describe(
          "Free-text nuance the audience+access pair can't hold (e.g. 'Members + public for the Saturday plant sale 9am-1pm')."
        ),
      registration_required: z
        .boolean()
        .optional()
        .describe(
          "True when advance registration is required to attend. Separate axis from audience/access."
        ),
      promoter_id: z
        .string()
        .optional()
        .describe("Promoter ID. If omitted, defaults to 'Community Suggestions'."),
      force_create: z
        .boolean()
        .optional()
        .describe(
          "Set to true to bypass duplicate detection and create the event even if potential duplicates exist at the same venue with overlapping dates."
        ),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      // Validate promoter FK if provided
      let eventPromoterId = COMMUNITY_PROMOTER_ID;
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
        eventPromoterId = params.promoter_id;
      }

      // Ensure community promoter exists
      const promoterRows = await db
        .select({ id: promoters.id })
        .from(promoters)
        .where(eq(promoters.id, COMMUNITY_PROMOTER_ID))
        .limit(1);

      if (promoterRows.length === 0) {
        await db.insert(promoters).values({
          id: COMMUNITY_PROMOTER_ID,
          companyName: "Community Suggestions",
          slug: unsafeSlug("community-suggestions"),
          description: "Events suggested by the community.",
          verified: false,
        });
      }

      // Generate unique slug — use canonical createSlug to match main-app and create_venue
      // (avoids the divergence that produced duplicate venues — see issue #120)
      const baseSlug = createSlug(params.name);
      let finalSlug = baseSlug;
      let suffix = 0;
      while (true) {
        const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
        const existing = await db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.slug, unsafeSlug(candidate)))
          .limit(1);
        if (existing.length === 0) {
          finalSlug = candidate;
          break;
        }
        suffix++;
      }

      let startDate: Date | null = null;
      let endDate: Date | null = null;
      if (params.start_date) {
        startDate = new Date(params.start_date);
        if (isNaN(startDate.getTime())) startDate = null;
      }
      if (params.end_date) {
        endDate = new Date(params.end_date);
        if (isNaN(endDate.getTime())) endDate = null;
      }

      // Build description
      const description = params.description || `${params.name} - suggested via MCP`;

      // ── Venue matching / creation ──────────────────────────────────
      let venueId: string | null = null;
      let venueResult: { matched: boolean; venueId: string; name: string } | null = null;

      if (params.venue_name) {
        // DQ2 (2026-06-04): coerce address-as-name BEFORE slug + dedup. AI
        // extraction occasionally pulls a street address as the venue
        // name (the U9 root cause). Running the coercion here means the
        // dedup paths and slug all see the derived name "Event venue in
        // {City}, {State}" instead of the raw "18 Spring Street", which
        // both prevents the bad ingest and keeps the slug stable.
        const _coerced = coerceVenueNameAtIngest({
          name: params.venue_name,
          address: null, // suggest_event auto-create writes address: "" below
          city: params.venue_city,
          state: params.venue_state,
        });
        const effectiveVenueName = _coerced.name;
        // Use canonical createSlug so this lookup matches what create_venue
        // (admin.ts) writes — divergence here caused duplicate venues (issue #120).
        const venueSlug = createSlug(effectiveVenueName);
        const venueCity = (params.venue_city || "").toLowerCase().trim();
        const venueState = (params.venue_state || "").toUpperCase().trim();

        // Search for existing venue by slug OR by normalized name. The
        // name-equality fallback catches pre-canonical rows whose stored
        // slug doesn't round-trip through current createSlug — e.g.
        // "Earth Expo & Convention Center at Mohegan Sun" is stored with
        // slug "earth-expo-convention-center-at-mohegan-sun" (legacy
        // generator stripped "&"), but canonical createSlug produces
        // "earth-expo-and-convention-center-at-mohegan-sun" (slugify
        // expands "&" to "and"). Slug-only matching missed the row and
        // silently created 3 duplicate Earth Expo venues during a CT
        // discovery session 2026-05-26. Schema-level entity decoding via
        // sanitizeProse already covers `&amp;`-style inputs; this guards
        // the orthogonal "stored slug pre-dates current generator" case.
        // Match on the coerced name — if `params.venue_name` was a street
        // address, we want to match an existing "Event venue in {City}"
        // (the coerced form), not the raw address that no real row carries.
        const normalizedVenueName = effectiveVenueName.trim().toLowerCase();
        const existingVenues = await db
          .select({
            id: venues.id,
            name: venues.name,
            slug: venues.slug,
            city: venues.city,
            state: venues.state,
          })
          .from(venues)
          .where(
            or(
              eq(venues.slug, unsafeSlug(venueSlug)),
              sql`LOWER(TRIM(${venues.name})) = ${normalizedVenueName}`
            )
          );

        let matched = false;

        if (existingVenues.length > 0 && venueCity) {
          // Match by slug + city
          const cityMatch = existingVenues.find((v) => v.city.toLowerCase().trim() === venueCity);
          if (cityMatch) {
            venueId = cityMatch.id;
            venueResult = { matched: true, venueId: cityMatch.id, name: cityMatch.name };
            matched = true;
          }
        } else if (existingVenues.length > 0 && !venueCity && venueState) {
          // No city — try state match
          const stateMatch = existingVenues.find(
            (v) => v.state.toUpperCase().trim() === venueState
          );
          if (stateMatch) {
            venueId = stateMatch.id;
            venueResult = { matched: true, venueId: stateMatch.id, name: stateMatch.name };
            matched = true;
          }
        } else if (existingVenues.length > 0) {
          // No city or state — use first match
          venueId = existingVenues[0].id;
          venueResult = {
            matched: true,
            venueId: existingVenues[0].id,
            name: existingVenues[0].name,
          };
          matched = true;
        }

        if (!matched) {
          // Create new venue — generate unique slug. Only disambiguate
          // when the canonical slug *actually* collides — a name-only
          // match found by the OR clause above can have a different stored
          // slug (legacy generator), in which case `venueSlug` is still
          // free and the simple form is preferred.
          let finalVenueSlug = venueSlug;
          const slugCollides = existingVenues.some((v) => v.slug === unsafeSlug(venueSlug));
          if (slugCollides) {
            finalVenueSlug = venueCity
              ? appendSlugSegment(venueSlug, createSlug(venueCity))
              : appendSlugSegment(venueSlug, crypto.randomUUID().substring(0, 8));
          }
          // Ensure slug uniqueness
          const slugCheck = await db
            .select({ id: venues.id })
            .from(venues)
            .where(eq(venues.slug, unsafeSlug(finalVenueSlug)))
            .limit(1);
          if (slugCheck.length > 0) {
            finalVenueSlug = appendSlugSegment(finalVenueSlug, crypto.randomUUID().substring(0, 8));
          }

          const newVenueId = crypto.randomUUID();
          // DQ2: write the coerced name. If the original `params.venue_name`
          // looked like a street address, push it into `address` instead
          // so the operator can later edit a proper name without losing
          // the address text the AI extracted.
          const newAddress = _coerced.wasCoerced && _coerced.address ? _coerced.address : "";
          await db.insert(venues).values({
            id: newVenueId,
            name: effectiveVenueName,
            slug: finalVenueSlug,
            address: newAddress,
            city: params.venue_city || "",
            state: (params.venue_state || "").toUpperCase(),
            zip: "",
            status: "ACTIVE",
          });
          venueId = newVenueId;
          venueResult = { matched: false, venueId: newVenueId, name: effectiveVenueName };
        }
      }

      // ── Duplicate detection (K2 rewire, 2026-06-04) ──────────────
      // Was: inline venue+date-overlap query at the same venueId only.
      // Now: delegates to /api/suggest-event/check-duplicate which runs
      // the shared `findDuplicate` 4-stage match (exact_url > venue_date
      // > city_state_date > similar_name_date, ±7d window). Catches the
      // Winthrop-shape duplicate the old code missed (PENDING 25ef60f0
      // vs APPROVED 4ee1de4a — same date + same town, slightly
      // different venue rows + name variants).
      //
      // `force_create: true` still bypasses, same as before. Skipped
      // entirely when startDate is missing — A2's required start_date
      // schema guarantees this is set, but the guard stays as
      // belt-and-suspenders.
      if (startDate && !params.force_create) {
        const dupe = await checkDuplicateViaMainApp(env ?? {}, {
          sourceUrl: params.source_url ?? null,
          name: params.name ?? null,
          startDate: params.start_date ?? null,
          venueName: params.venue_name ?? null,
          venueCity: params.venue_city ?? null,
          venueState: params.venue_state ?? null,
        });
        if (dupe.isDuplicate) {
          return {
            content: [
              jsonContent({
                created: false,
                reason: "potential_duplicates_found",
                match_type: dupe.matchType,
                similarity: dupe.similarity,
                message: `Found an existing event matching on \`${dupe.matchType}\`. Use force_create: true to create anyway.`,
                possible_duplicates: [
                  {
                    id: dupe.existingEvent.id,
                    name: dupe.existingEvent.name,
                    slug: dupe.existingEvent.slug,
                    dates: formatDateRange(dupe.existingEvent.startDate, null),
                    status: dupe.existingEvent.status,
                  },
                ],
                suggested_event: {
                  name: params.name,
                  venue_id: venueId,
                  venue_name: venueResult?.name || params.venue_name,
                  start_date: params.start_date,
                  end_date: params.end_date,
                },
              }),
            ],
          };
        }
      }

      // Gate the agent-supplied URLs against the domain classification table
      // so MCP-driven suggestions can't reintroduce aggregator URLs.
      // - ticket_url: dropped silently if classified non-ticket
      // - source_url: REJECTS the whole suggestion if classified non-source
      //   (a blocked aggregator as source would taint downstream rescraping)
      const classifications = await loadClassifications(db);
      if (params.source_url && !shouldIngestFromSource(params.source_url, classifications)) {
        return {
          content: [
            {
              type: "text",
              text: `Source URL domain is not allowed for ingestion (classified as non-source). Suggestion not created.`,
            },
          ],
          isError: true,
        };
      }
      const gatedTicketUrl = await gateUrlOnce(db, params.ticket_url, "ticket");

      // Pre-ingest date-quality gates. Same evaluator the main-app paths use
      // — imported from @takemetothefair/utils so MCP + main app share one
      // source of truth. Vendor submissions default to TENTATIVE; a gate
      // failure downgrades them to PENDING with the trace in gate_flags.
      const gateResult = evaluateGates({
        name: params.name,
        sourceUrl: params.source_url ?? null,
        sourceName: "vendor-submission",
        startDate,
        endDate,
        applicationDeadline: null,
        description,
      });
      const eventStatus = gateResult.route === "PENDING_REVIEW" ? "PENDING" : "TENTATIVE";
      const gateFlagsJson =
        gateResult.reasons.length > 0 ? JSON.stringify(gateResult.reasons) : null;

      // TAX1 A11 (2026-06-02) — prefer caller-supplied categories.
      // When omitted, fall back to the legacy ["Event"] placeholder
      // AND log at level:"info" so /admin/source-quality can sample
      // how often this still happens. Invalid values are filtered out
      // (EVENT_CATEGORIES is the allow-list); empty result also falls
      // back. Don't fail the suggestion — agents pass categories on a
      // best-effort basis and a bad value shouldn't block ingest.
      //
      // K21 (2026-06-12) — off-list values used to vanish silently:
      // the caller got back ["Event"] with no signal, so a steady
      // stream of mis-categorized community/email submissions leaked
      // into the uncategorized queue invisibly. We now collect the
      // dropped values and echo them back in `warnings.dropped_categories`
      // so the caller (and the operator reading the reply) can see the
      // coercion happened. Storage behavior is unchanged.
      const validCategorySet = new Set<string>(EVENT_CATEGORIES);
      const providedCategories = params.categories ?? [];
      const filteredCategories = providedCategories.filter((c) => validCategorySet.has(c));
      const droppedCategories = providedCategories.filter((c) => !validCategorySet.has(c));
      const categoriesToStore = filteredCategories.length > 0 ? filteredCategories : ["Event"];
      if (categoriesToStore[0] === "Event") {
        await logError(db, {
          source: "mcp:suggest_event:uncategorized",
          message: "suggest_event landed without a valid category",
          level: "info",
          context: {
            providedCategories: params.categories ?? null,
            sourceUrl: params.source_url ?? null,
            name: params.name,
          },
        });
      }

      const eventId = crypto.randomUUID();
      await db.insert(events).values({
        id: eventId,
        name: params.name,
        slug: finalSlug,
        description,
        promoterId: eventPromoterId,
        venueId,
        startDate,
        endDate,
        datesConfirmed: startDate !== null,
        categories: JSON.stringify(categoriesToStore),
        tags: JSON.stringify(["community-suggestion", "vendor-submission"]),
        ticketUrl: gatedTicketUrl,
        status: eventStatus,
        gateFlags: gateFlagsJson,
        // TAX1 Phase 1 — undefined params let the column defaults
        // (PUBLIC / OPEN / 0) win at the D1 level. Drizzle's column
        // .default() is what populates pre-existing rows; for new
        // inserts we have to pass undefined (not the default value)
        // so the SQL omits the column from the INSERT clause and
        // SQLite applies DEFAULT.
        primaryAudience: params.primary_audience,
        publicAccess: params.public_access,
        accessNotes: params.access_notes,
        registrationRequired: params.registration_required,
        // Mirror the main-app suggest-event behavior: vendor submissions are
        // TENTATIVE-lifecycle (dates unconfirmed at submission time).
        lifecycleStatus: "TENTATIVE",
        sourceName: "vendor-submission",
        sourceDomain: classifySource("vendor-submission", params.source_url).sourceDomain,
        ingestionMethod:
          classifySource("vendor-submission", params.source_url).ingestionMethod ??
          "vendor_submission",
        sourceUrl: params.source_url || null,
        sourceId: params.source_url
          ? params.source_url
              .toLowerCase()
              // eslint-disable-next-line no-restricted-syntax -- sourceId is an external-system identifier derived from URL, not a slug. Stability matters more than canonical-slug semantics.
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
          : eventId,
        syncEnabled: false,
        lastSyncedAt: new Date(),
        submittedByUserId: auth.userId,
      });

      // IndexNow: TENTATIVE is publicly visible; ping for the new event and
      // any newly-created venue. Reused/matched venues are already indexed.
      // The auto-created promoter (if any) is NOT pinged — no public
      // /promoters/[slug] page exists.
      if (env) {
        await triggerIndexNow(publicUrlFor("events", finalSlug), env, "event-create", {
          defer: params.defer_search_ping ?? false,
          db,
          entity: { type: "event", id: eventId, slug: finalSlug, action: "create" },
        });
        if (venueResult && venueResult.matched === false) {
          const newVenue = await db
            .select({ slug: venues.slug })
            .from(venues)
            .where(eq(venues.id, venueResult.venueId))
            .limit(1);
          if (newVenue[0]?.slug) {
            await triggerIndexNow(publicUrlFor("venues", newVenue[0].slug), env, "venue-create", {
              defer: params.defer_search_ping ?? false,
              db,
              entity: {
                type: "venue",
                id: venueResult.venueId,
                slug: newVenue[0].slug,
                action: "create",
              },
            });
          }
        }
      }

      return {
        content: [
          jsonContent({
            created: true,
            event: { id: eventId, slug: finalSlug, name: params.name, status: "TENTATIVE" },
            venue: venueResult,
            // K21 — only present when the caller passed categories that
            // aren't on the canonical EVENT_CATEGORIES list. Lets the
            // caller detect that those values were dropped (the event
            // was still created with the valid subset, or ["Event"] if
            // none survived) instead of the prior silent coercion.
            ...(droppedCategories.length > 0 && {
              warnings: { dropped_categories: droppedCategories },
            }),
          }),
        ],
      };
    }
  );
}
