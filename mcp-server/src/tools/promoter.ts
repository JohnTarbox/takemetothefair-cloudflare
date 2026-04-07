import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { events, eventVendors, vendors, venues } from "../schema.js";
import {
  formatDateRange,
  parseJsonArray,
  jsonContent,
  VALID_TRANSITIONS,
  VENDOR_STATUS_ENUM,
  PAYMENT_STATUS_ENUM,
} from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerPromoterTools(server: McpServer, db: Db, auth: AuthContext) {
  if (!auth.promoterId) return; // No promoter profile — skip

  const promoterId = auth.promoterId;

  // ── list_my_events ─────────────────────────────────────────────
  server.tool(
    "list_my_events",
    "List events you are promoting, with application count summaries.",
    {
      status: z
        .enum(["DRAFT", "PENDING", "TENTATIVE", "APPROVED", "REJECTED", "CANCELLED"])
        .optional()
        .describe("Filter by event status"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [eq(events.promoterId, promoterId)];
      if (params.status) {
        conditions.push(eq(events.status, params.status));
      }

      const eventRows = await db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          status: events.status,
          categories: events.categories,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .where(and(...conditions))
        .limit(params.limit ?? 20)
        .offset(params.offset ?? 0);

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      // Batch-fetch vendor counts per event
      const eventIds = eventRows.map((e) => e.id);
      const vendorCounts: Record<string, { total: number; applied: number; confirmed: number }> = {};

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
        location: [e.venueName, e.venueCity, e.venueState].filter(Boolean).join(", ") || "TBD",
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

  // ── get_event_applications ─────────────────────────────────────
  server.tool(
    "get_event_applications",
    "View vendor applications for one of your events.",
    {
      event_slug: z.string().describe("Slug of your event"),
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
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      // Verify the event belongs to this promoter
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(and(eq(events.slug, params.event_slug), eq(events.promoterId, promoterId)))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found or you are not the promoter." }],
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
        .limit(params.limit ?? 50)
        .offset(params.offset ?? 0);

      const appLimit = params.limit ?? 50;
      const appOffset = params.offset ?? 0;

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
            offset: appOffset,
            has_more: output.length === appLimit,
            applications: output,
          }),
        ],
      };
    }
  );

  // ── update_application_status ─────────────────────────────────
  server.tool(
    "update_application_status",
    "Approve, reject, waitlist, or change a vendor's application status on one of your events. Promoter only.",
    {
      event_slug: z.string().describe("Slug of your event"),
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

      // Verify event belongs to this promoter
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(and(eq(events.slug, params.event_slug), eq(events.promoterId, promoterId)))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found or you are not the promoter." }],
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
            eq(eventVendors.eventId, eventRows[0].id),
            eq(eventVendors.vendorId, params.vendor_id)
          )
        )
        .limit(1);

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No application found for this vendor on this event." }],
          isError: true,
        };
      }

      const record = rows[0];
      const updates: Record<string, unknown> = {};
      const result: Record<string, unknown> = {
        updated: true,
        event: eventRows[0].name,
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
                text: `Invalid transition: ${record.status} → ${params.status}. Allowed from ${record.status}: ${(allowed || []).join(", ") || "none"}.`,
              },
            ],
            isError: true,
          };
        }
        updates.status = params.status;
        result.previousStatus = record.status;
        result.newStatus = params.status;
      }

      if (params.payment_status) {
        updates.paymentStatus = params.payment_status;
        result.previousPaymentStatus = record.paymentStatus;
        result.newPaymentStatus = params.payment_status;
      }

      await db.update(eventVendors).set(updates).where(eq(eventVendors.id, record.id));

      return { content: [jsonContent(result)] };
    }
  );
}
