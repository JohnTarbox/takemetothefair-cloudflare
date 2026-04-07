import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { vendors, events, eventVendors, promoters, venues } from "../schema.js";
import { parseJsonArray, formatDateRange, jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const COMMUNITY_PROMOTER_ID = "system-community-suggestions";

export function registerVendorTools(server: McpServer, db: Db, auth: AuthContext) {
  // suggest_event only needs userId, not a vendor profile — register it first
  console.log(
    `[VENDOR-TOOLS] Registering suggest_event for userId=${auth.userId} role=${auth.role} vendorId=${auth.vendorId || "none"}`
  );
  registerSuggestEvent(server, db, auth);

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
        }),
      ],
    };
  });

  // ── update_vendor_profile ──────────────────────────────────────
  server.tool(
    "update_vendor_profile",
    "Update your vendor profile fields. Only provided fields are updated.",
    {
      description: z.string().optional().describe("Business description"),
      vendor_type: z.string().optional().describe("Type of vendor (e.g., Food, Crafts)"),
      products: z.array(z.string()).optional().describe("List of products/services"),
      website: z.string().optional().describe("Website URL"),
      contact_name: z.string().optional().describe("Contact person name"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
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

      if (Object.keys(updates).length === 0) {
        return { content: [{ type: "text", text: "No fields to update." }], isError: true };
      }

      updates.updatedAt = new Date();

      await db.update(vendors).set(updates).where(eq(vendors.id, vendorId));

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
      booth_info: z.string().optional().describe("Booth/space requirements or notes"),
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
        .where(eq(events.slug, params.event_slug))
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
        .where(eq(events.slug, params.event_slug))
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
}

// ---------------------------------------------------------------------------
// suggest_event — registered separately since it only needs userId, not vendorId
// ---------------------------------------------------------------------------
function registerSuggestEvent(server: McpServer, db: Db, auth: AuthContext) {
  server.tool(
    "suggest_event",
    "Suggest a new event to be added to the platform. The event will be created with TENTATIVE status.",
    {
      name: z.string().describe("Event name"),
      description: z.string().optional().describe("Event description"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      venue_name: z.string().optional().describe("Venue name"),
      venue_city: z.string().optional().describe("Venue city"),
      venue_state: z.string().optional().describe("Venue state (2-letter code)"),
      ticket_url: z.string().optional().describe("URL to purchase tickets"),
      source_url: z.string().optional().describe("URL with more information about the event"),
    },
    async (params) => {
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
          slug: "community-suggestions",
          description: "Events suggested by the community.",
          verified: false,
        });
      }

      // Generate unique slug
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
        const venueSlug = params.venue_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        const venueCity = (params.venue_city || "").toLowerCase().trim();
        const venueState = (params.venue_state || "").toUpperCase().trim();

        // Search for existing venue by slug (same pattern as scraper import)
        const existingVenues = await db
          .select({ id: venues.id, name: venues.name, city: venues.city, state: venues.state })
          .from(venues)
          .where(eq(venues.slug, venueSlug));

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
          // Create new venue — generate unique slug
          let finalVenueSlug = venueSlug;
          if (existingVenues.length > 0) {
            finalVenueSlug = venueCity
              ? `${venueSlug}-${venueCity.replace(/[^a-z0-9]+/g, "-")}`
              : `${venueSlug}-${crypto.randomUUID().substring(0, 8)}`;
          }
          // Ensure slug uniqueness
          const slugCheck = await db
            .select({ id: venues.id })
            .from(venues)
            .where(eq(venues.slug, finalVenueSlug))
            .limit(1);
          if (slugCheck.length > 0) {
            finalVenueSlug = `${finalVenueSlug}-${crypto.randomUUID().substring(0, 8)}`;
          }

          const newVenueId = crypto.randomUUID();
          await db.insert(venues).values({
            id: newVenueId,
            name: params.venue_name,
            slug: finalVenueSlug,
            address: "",
            city: params.venue_city || "",
            state: params.venue_state || "",
            zip: "",
            status: "ACTIVE",
          });
          venueId = newVenueId;
          venueResult = { matched: false, venueId: newVenueId, name: params.venue_name };
        }
      }

      const eventId = crypto.randomUUID();
      await db.insert(events).values({
        id: eventId,
        name: params.name,
        slug: finalSlug,
        description,
        promoterId: COMMUNITY_PROMOTER_ID,
        venueId,
        startDate,
        endDate,
        datesConfirmed: startDate !== null,
        categories: JSON.stringify(["Event"]),
        tags: JSON.stringify(["community-suggestion", "vendor-submission"]),
        ticketUrl: params.ticket_url || null,
        status: "TENTATIVE",
        sourceName: "vendor-submission",
        sourceUrl: params.source_url || null,
        sourceId: params.source_url
          ? params.source_url
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
          : eventId,
        syncEnabled: false,
        lastSyncedAt: new Date(),
        submittedByUserId: auth.userId,
      });

      return {
        content: [
          jsonContent({
            created: true,
            event: { id: eventId, slug: finalSlug, name: params.name, status: "TENTATIVE" },
            venue: venueResult,
          }),
        ],
      };
    }
  );
}
