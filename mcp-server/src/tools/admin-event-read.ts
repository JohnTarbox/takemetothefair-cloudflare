/**
 * OPE-500 — read an event REGARDLESS of status.
 *
 * `get_event_details` filters to publicly-visible rows. That filter is inverted
 * relative to need: APPROVED rows have already been adjudicated, while PENDING
 * rows are the queue a reviewer is being asked to judge — and those are the ones
 * the good reader refused, reporting "Event not found" for a row
 * `list_all_events` returned by the same slug.
 *
 * Measured 2026-08-20: `womens-collective-market-september` and `lita-fest`
 * (both PENDING) → "Event not found"; `sunday-women-s-market` (APPROVED) → full
 * record. The 08-20 review had to reconstruct a PENDING row from three tools and
 * still never obtained its description or schedule.
 *
 * A separate ADMIN tool rather than a `status` parameter on the public one,
 * deliberately: the public registrar is wired before authentication exists on
 * the legacy transport, so a status flag there would have no role to check
 * against and would hand un-adjudicated rows to unauthenticated callers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { events, eventDays, eventVendors, promoters, vendors, venues } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const PUBLIC_VENDOR_STATUSES = ["APPROVED", "CONFIRMED"] as const;

export function registerAdminEventReadTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_event_details_admin",
    "Read one event in full by slug OR id, at ANY status — including PENDING, TENTATIVE and REJECTED rows that get_event_details filters out. Returns the same record plus status, lifecycle_status, dates_confirmed, and RAW ISO start/end dates alongside the formatted string. Use this to review an un-adjudicated submission: the public reader reports those as 'not found'. Read-only. Admin only.",
    {
      slug: z.string().optional().describe("Event slug."),
      event_id: z
        .string()
        .optional()
        .describe(
          "Event UUID — the 08-20 trace started from one of these and had to go slug-hunting."
        ),
    },
    async (params) => {
      if (!params.slug && !params.event_id) {
        return {
          content: [jsonContent({ error: "slug_or_event_id_required" })],
          isError: true,
        };
      }

      const [event] = await db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          description: events.description,
          status: events.status,
          lifecycleStatus: events.lifecycleStatus,
          startDate: events.startDate,
          endDate: events.endDate,
          datesConfirmed: events.datesConfirmed,
          gateFlags: events.gateFlags,
          categories: events.categories,
          tags: events.tags,
          ticketUrl: events.ticketUrl,
          sourceUrl: events.sourceUrl,
          sourceName: events.sourceName,
          sourceDomain: events.sourceDomain,
          ingestionMethod: events.ingestionMethod,
          mergedInto: events.mergedInto,
          seriesId: events.seriesId,
          viewCount: events.viewCount,
          createdAt: events.createdAt,
          updatedAt: events.updatedAt,
          venueId: events.venueId,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
          promoterId: events.promoterId,
          promoterName: promoters.companyName,
          promoterSlug: promoters.slug,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id))
        .where(
          params.event_id
            ? eq(events.id, params.event_id)
            : eq(events.slug, unsafeSlug(params.slug as string))
        )
        .limit(1);

      if (!event) {
        return {
          content: [
            jsonContent({
              error: "event_not_found",
              slug: params.slug ?? null,
              event_id: params.event_id ?? null,
              detail:
                "No row at any status. This tool does not filter by status, so the row genuinely does not exist.",
            }),
          ],
          isError: true,
        };
      }

      const vendorRows = await db
        .select({ id: eventVendors.id })
        .from(eventVendors)
        .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .where(
          and(
            eq(eventVendors.eventId, event.id),
            inArray(eventVendors.status, [...PUBLIC_VENDOR_STATUSES]),
            isNull(vendors.deletedAt)
          )
        );

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
            id: event.id,
            name: event.name,
            slug: event.slug,
            // Named first and never omitted: the whole point of this tool is
            // reading rows that are NOT live, so a caller must not be able to
            // mistake one for a published event.
            status: event.status,
            lifecycle_status: event.lifecycleStatus,
            is_publicly_visible: event.status === "APPROVED" && event.mergedInto === null,
            merged_into: event.mergedInto,
            description: event.description,
            // OPE-482 — raw values, not just the rendered string. MCP shares the
            // site's formatter, so a formatted date read back is not an
            // independent check of what is stored.
            start_date: event.startDate ? new Date(event.startDate).toISOString() : null,
            end_date: event.endDate ? new Date(event.endDate).toISOString() : null,
            dates_confirmed: event.datesConfirmed,
            gate_flags: event.gateFlags,
            categories: event.categories,
            tags: event.tags,
            ticket_url: event.ticketUrl,
            provenance: {
              source_url: event.sourceUrl,
              source_name: event.sourceName,
              source_domain: event.sourceDomain,
              ingestion_method: event.ingestionMethod,
            },
            series_id: event.seriesId,
            view_count: event.viewCount,
            created_at: event.createdAt ? new Date(event.createdAt).toISOString() : null,
            updated_at: event.updatedAt ? new Date(event.updatedAt).toISOString() : null,
            venue: event.venueId
              ? {
                  id: event.venueId,
                  name: event.venueName,
                  city: event.venueCity,
                  state: event.venueState,
                }
              : null,
            promoter: event.promoterId
              ? { id: event.promoterId, name: event.promoterName, slug: event.promoterSlug }
              : null,
            vendor_count: vendorRows.length,
            schedule: days.map((d) => ({
              date: d.date ? new Date(d.date).toISOString().slice(0, 10) : null,
              open_time: d.openTime,
              close_time: d.closeTime,
              notes: d.notes,
            })),
          }),
        ],
      };
    }
  );
}
