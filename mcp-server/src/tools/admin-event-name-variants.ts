/**
 * OPE-517 — the other names an event is known by.
 *
 * An event row holds exactly one `name`. When the organizer, an aggregator and
 * we each call a fair something different, only one of those strings can exist
 * in the system and the rest are unsearchable.
 *
 * The specimen: the Island Arts Association publishes twelve fairs. Dates,
 * venues and hours matched our twelve rows exactly — and **all twelve names
 * differed**. The Oct 10-11 fair has three names in circulation at once:
 *
 *   organizer   October Craft Fair at Atlantic Oceanside
 *   chamber     Island Artisans Craft Fair
 *   us          Bar Harbor Fall Craft Fair 2026   (2,359 views)
 *
 * Someone searching the name printed on the poster does not find the page we
 * already rank for. That is an acquisition loss on inventory we already have.
 *
 * ── ⚠️ This is not an alias, and the naming is load-bearing ──────────────
 *
 * `set_vendor_alias` and `set_performer_alias` are DEDUP tools: "this ROW is
 * that row, differently spelled". They soft-delete, rename a slug, repoint
 * associations. Events already have that capability — `merge_events`.
 *
 * These tools are the other thing entirely: ONE surviving row, several names it
 * is legitimately known by, no second row anywhere. The ticket asked for names
 * that cannot be confused with dedup, and that request is the design note: a
 * tool called `set_event_alias` would have invited someone to implement a merge.
 *
 * ── Why a variant and not a rename ──────────────────────────────────────
 *
 * The cheap alternative is to set `name` to the organizer's string. That
 * changes twelve slugs on pages with live view history, and a rename carries
 * side effects found on 2026-08-21: it can silently mint a `series_id`, and
 * citation supersede missed year-null rows until OPE-516. A variant touches
 * none of it — `name`, `slug`, `status` and `merged_into` are never written
 * here, and a test pins that.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { eventNameVariants, events } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const VARIANT_TYPES = ["organizer_official", "aggregator", "historical", "common_usage"] as const;

export function registerEventNameVariantTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  // --- add_event_name_variant ----------------------------------------------
  server.tool(
    "add_event_name_variant",
    "Record ANOTHER name an event is known by — the organizer's own name, an aggregator's, or last year's — without changing the event's name or slug. Use when a source calls a fair something different and you want that name to be findable. This is NOT dedup: it never merges, renames or deletes anything. To merge two duplicate event rows, use merge_events instead. Admin only.",
    {
      event_id: z.string().describe("Event ID (UUID)"),
      variant: z
        .string()
        .min(2)
        .max(300)
        .describe("The other name, verbatim as the source writes it."),
      variant_type: z
        .enum(VARIANT_TYPES)
        .default("common_usage")
        .describe("Who calls it this. Provenance, not precedence."),
      source_url: z
        .string()
        .url()
        .optional()
        .describe("Where this name was published. Makes 'where did this come from' answerable."),
    },
    async (params: {
      event_id: string;
      variant: string;
      variant_type: (typeof VARIANT_TYPES)[number];
      source_url?: string;
    }) => {
      const [event] = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      if (!event) {
        return { content: [jsonContent({ ok: false, error: "event_not_found" })], isError: true };
      }

      const variant = params.variant.trim();
      // Recording the canonical name as a variant of itself is a no-op that
      // would pollute search with a duplicate hit on every row.
      if (variant.toLowerCase() === event.name.trim().toLowerCase()) {
        return {
          content: [
            jsonContent({
              ok: false,
              error: "same_as_canonical",
              detail: "That is already the event's name; a variant must be a DIFFERENT name.",
            }),
          ],
        };
      }

      // Idempotent: the unique index makes a re-record a no-op rather than a
      // duplicate, so an unattended writer can call this repeatedly.
      await db
        .insert(eventNameVariants)
        .values({
          eventId: params.event_id,
          variant,
          variantType: params.variant_type,
          sourceUrl: params.source_url ?? null,
          createdBy: auth.userId ?? null,
          createdAt: new Date(),
        })
        .onConflictDoNothing();

      const rows = await db
        .select()
        .from(eventNameVariants)
        .where(eq(eventNameVariants.eventId, params.event_id));

      return {
        content: [
          jsonContent({
            ok: true,
            event_id: params.event_id,
            canonical_name: event.name,
            variant,
            variant_type: params.variant_type,
            total_variants: rows.length,
            note: "The event's name and slug are unchanged — this only adds a name it can be found by.",
          }),
        ],
      };
    }
  );

  // --- list_event_name_variants --------------------------------------------
  server.tool(
    "list_event_name_variants",
    "List the other names an event is known by, with the source each came from. Read-only. Admin only.",
    { event_id: z.string().describe("Event ID (UUID)") },
    async (params: { event_id: string }) => {
      const [event] = await db
        .select({ name: events.name, slug: events.slug })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      const rows = await db
        .select()
        .from(eventNameVariants)
        .where(eq(eventNameVariants.eventId, params.event_id))
        .orderBy(desc(eventNameVariants.createdAt));

      return {
        content: [
          jsonContent({
            event_id: params.event_id,
            canonical_name: event?.name ?? null,
            canonical_slug: event?.slug ?? null,
            variants: rows.map((r) => ({
              id: r.id,
              variant: r.variant,
              variant_type: r.variantType,
              source_url: r.sourceUrl,
              created_by: r.createdBy,
            })),
          }),
        ],
      };
    }
  );

  // --- remove_event_name_variant -------------------------------------------
  server.tool(
    "remove_event_name_variant",
    "Remove one name variant from an event. Does not touch the event itself. Admin only.",
    {
      event_id: z.string().describe("Event ID (UUID)"),
      variant: z.string().describe("The exact variant string to remove."),
    },
    async (params: { event_id: string; variant: string }) => {
      const before = await db
        .select({ id: eventNameVariants.id })
        .from(eventNameVariants)
        .where(
          and(
            eq(eventNameVariants.eventId, params.event_id),
            eq(eventNameVariants.variant, params.variant.trim())
          )
        );
      if (before.length === 0) {
        return { content: [jsonContent({ ok: false, error: "variant_not_found" })] };
      }
      await db
        .delete(eventNameVariants)
        .where(
          and(
            eq(eventNameVariants.eventId, params.event_id),
            eq(eventNameVariants.variant, params.variant.trim())
          )
        );
      return { content: [jsonContent({ ok: true, removed: before.length })] };
    }
  );
}
