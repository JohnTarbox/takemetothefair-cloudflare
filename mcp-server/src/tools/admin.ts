import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, like, inArray } from "drizzle-orm";
import { events, eventVendors, vendors, venues, promoters } from "../schema.js";
import { formatDateRange, parseJsonArray, escapeLike, jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

// ---------------------------------------------------------------------------
// Vendor status transition map — duplicated from src/lib/vendor-status.ts.
// KEEP IN SYNC: changes to the main app's VALID_TRANSITIONS must be reflected here.
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

export function registerAdminTools(server: McpServer, db: Db, auth: AuthContext) {
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
}
