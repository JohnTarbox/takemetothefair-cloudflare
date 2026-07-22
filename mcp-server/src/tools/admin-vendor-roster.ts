import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { adminActions, events, eventVendors, vendors } from "../schema.js";
import { VENDOR_ROSTER_STATUS_VALUES } from "@takemetothefair/constants";
import { jsonContent, PUBLIC_VENDOR_STATUSES, unsafeSlug } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/**
 * OPE-13 (vendor-roster rails) — the write path the analyst research worker
 * uses to record the outcome of a roster-backfill attempt. The just-occurred
 * sweep (event-occurred-sweep.ts) ENQUEUES events as NEEDS_RESEARCH; this tool
 * is how the worker moves them to a terminal state:
 *
 *   HAS_ROSTER     — roster found + attached
 *   NO_PUBLIC_LIST — researched dead-end (the sticky state that stops the
 *                    Sisyphean re-research and makes the system converge)
 *   PARTIAL        — incomplete; pass `offset` so the next run resumes there
 *   NEEDS_RESEARCH — manual re-enqueue (rarely needed; normally the sweep sets it)
 *
 * Read the current state via get_event_details (`vendorRoster` block).
 */
export function registerVendorRosterTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "set_vendor_roster_status",
    [
      "Record the vendor-roster research state for an event (OPE-13 rails).",
      "Pass either event_id or event_slug (event_id wins). `status` is one of",
      "NEEDS_RESEARCH | HAS_ROSTER | NO_PUBLIC_LIST | PARTIAL. For a terminal",
      "status (everything except NEEDS_RESEARCH) vendor_roster_checked_at is",
      "stamped now. Pass source_url for the exhibitor page used, and offset",
      "(resume point) when status=PARTIAL. Writes an admin_actions audit row.",
      "Mirrors the read surfaced by get_event_details.vendorRoster.",
    ].join(" "),
    {
      event_id: z.string().min(1).optional().describe("Event ID (UUID or legacy hex)."),
      event_slug: z.string().min(1).optional().describe("Event slug."),
      status: z
        .enum(VENDOR_ROSTER_STATUS_VALUES)
        .describe("NEEDS_RESEARCH | HAS_ROSTER | NO_PUBLIC_LIST | PARTIAL"),
      source_url: z
        .string()
        .url()
        .optional()
        .describe("URL of the exhibitor/roster page the status was derived from."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Resume point for PARTIAL rosters (source-list offset reached)."),
    },
    async (params) => {
      if (!params.event_id && !params.event_slug) {
        return {
          content: [{ type: "text", text: "event_id or event_slug is required." }],
          isError: true,
        };
      }

      // PARTIAL without an offset is a soft mistake — the whole point of PARTIAL
      // is the resume point. Warn but don't block (offset may legitimately be 0).
      const warnings: string[] = [];
      if (params.status === "PARTIAL" && params.offset === undefined) {
        warnings.push("PARTIAL set without an offset — the next run cannot resume precisely.");
      }
      // OPE-264: a terminal status with no source_url is un-auditable — you can
      // never re-verify where a HAS_ROSTER/NO_PUBLIC_LIST verdict came from. Warn
      // (don't block: a roster may legitimately come from a non-URL source such
      // as an attachment), mirroring the PARTIAL-without-offset soft check above.
      if (
        (params.status === "HAS_ROSTER" || params.status === "NO_PUBLIC_LIST") &&
        !params.source_url
      ) {
        warnings.push(
          `${params.status} set without a source_url — this terminal verdict cannot be audited or re-verified later.`
        );
      }

      const rows = params.event_id
        ? await db
            .select({ id: events.id, slug: events.slug, status: events.vendorRosterStatus })
            .from(events)
            .where(eq(events.id, params.event_id))
            .limit(1)
        : await db
            .select({ id: events.id, slug: events.slug, status: events.vendorRosterStatus })
            .from(events)
            .where(eq(events.slug, unsafeSlug(params.event_slug!)))
            .limit(1);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }
      const event = rows[0];
      const previous = event.status;

      // Terminal statuses are "researched"; NEEDS_RESEARCH is "not yet attempted",
      // so only the terminal ones stamp checked_at. source_url/offset are set
      // when provided and cleared on NEEDS_RESEARCH re-enqueue (a fresh attempt).
      const now = new Date();
      const isTerminal = params.status !== "NEEDS_RESEARCH";
      await db
        .update(events)
        .set({
          vendorRosterStatus: params.status,
          vendorRosterCheckedAt: isTerminal ? now : null,
          vendorRosterSourceUrl: isTerminal ? (params.source_url ?? null) : null,
          vendorRosterOffset: params.status === "PARTIAL" ? (params.offset ?? null) : null,
          updatedAt: now,
        })
        .where(eq(events.id, event.id));

      await db.insert(adminActions).values({
        action: "event.vendor_roster_status",
        actorUserId: auth.userId,
        targetType: "event",
        targetId: event.id,
        payloadJson: JSON.stringify({
          previous_status: previous,
          new_status: params.status,
          source_url: params.source_url ?? null,
          offset: params.status === "PARTIAL" ? (params.offset ?? null) : null,
          slug: event.slug,
        }),
        createdAt: now,
      });

      // Live (soft-delete-filtered) roster count, so the worker can sanity-check
      // that HAS_ROSTER actually has links attached.
      const linked = await db
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

      return {
        content: [
          jsonContent({
            event_id: event.id,
            slug: event.slug,
            previous_status: previous,
            status: params.status,
            checked_at: isTerminal ? now.toISOString() : null,
            source_url: isTerminal ? (params.source_url ?? null) : null,
            offset: params.status === "PARTIAL" ? (params.offset ?? null) : null,
            linked_vendor_count: linked.length,
            warnings,
          }),
        ],
      };
    }
  );
}
