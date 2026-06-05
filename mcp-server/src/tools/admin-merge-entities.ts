/**
 * DQ1 follow-up (2026-06-05) — merge_venue + merge_promoter MCP tools.
 *
 * Closes the named-deferral from PR #337. The DQ1 sweep endpoint
 * surfaces venue + promoter clusters; this is the write side that
 * resolves them.
 *
 * Mirrors `merge_events`'s reassign-then-tombstone pattern from
 * admin-event-lifecycle.ts, but with one important scope cut:
 *
 *   **No slug-history rows are written.** `venue_slug_history` and
 *   `promoter_slug_history` tables don't exist (events have one,
 *   blogs have one, vendors have one — venues and promoters don't).
 *   Building them properly would require new D1 migrations, schema
 *   changes, AND middleware updates to walk the new tables for 301
 *   redirects. That's a larger lift than DQ1 asked for. For now: the
 *   loser slug is renamed to `*-merged-<id8>` so the URL is free for
 *   future re-creation, but visiting the old slug 404s instead of
 *   301-ing to the keeper.
 *
 *   **Accepted SEO trade-off**: venues and promoters generally have
 *   less inbound link equity than events (where K3's merge_events DID
 *   write slug-history). If the slug-history gap proves painful, the
 *   natural follow-up is to mirror eventSlugHistory + middleware logic
 *   for the two new tables.
 *
 * Per-entity differences from merge_events:
 *
 *   merge_venue:
 *     1. Refuse self-merge or already-INACTIVE duplicate.
 *     2. UPDATE events SET venue_id = keeper WHERE venue_id = duplicate
 *     3. UPDATE venues SET status='INACTIVE', slug='*-merged-<id8>'
 *        WHERE id = duplicate (audit-preserving — venue row stays;
 *        operator can still query it by id).
 *     4. WRITE admin_actions(action='venue.merge')
 *
 *   merge_promoter:
 *     1. Refuse self-merge.
 *     2. UPDATE events SET promoter_id = keeper WHERE promoter_id = duplicate
 *     3. promoters has no status column, but events.promoter_id has
 *        ON DELETE CASCADE. Since we already reassigned, the cascade
 *        has nothing to cascade — safe to hard-delete.
 *     4. WRITE admin_actions(action='promoter.merge')
 *
 * Both tools fail-soft on missing input + return a structured result.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { events, venues, promoters, adminActions } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { jsonContent, unsafeSlug } from "../helpers.js";

export function registerMergeEntitiesTools(server: McpServer, db: Db, auth: AuthContext) {
  // ── merge_venue ─────────────────────────────────────────────────
  server.tool(
    "merge_venue",
    "Merge two venue rows. Reassigns all events from the duplicate to the keeper, then marks the duplicate INACTIVE with a `*-merged-<id8>` slug. NO slug-history written (gap vs `merge_events` — old slug will 404 instead of 301; accept as SEO trade-off for venues, which have less inbound link equity than events). Refuses self-merge or already-merged duplicate. Admin only.",
    {
      keeper_venue_id: z
        .string()
        .min(1)
        .describe(
          "The venue row to keep. All events pointing at the duplicate will be reassigned here."
        ),
      duplicate_venue_id: z
        .string()
        .min(1)
        .describe(
          "The venue row to retire. After merge: events reassigned, status=INACTIVE, slug renamed."
        ),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Forbidden — admin only." }],
          isError: true,
        };
      }
      if (params.keeper_venue_id === params.duplicate_venue_id) {
        return {
          content: [
            { type: "text" as const, text: "Refused: keeper and duplicate are the same venue." },
          ],
          isError: true,
        };
      }

      // Load both rows to confirm existence + grab the duplicate's slug
      // for the tombstone rename.
      const [keeper, dup] = await Promise.all([
        db.select().from(venues).where(eq(venues.id, params.keeper_venue_id)).limit(1),
        db.select().from(venues).where(eq(venues.id, params.duplicate_venue_id)).limit(1),
      ]);
      if (keeper.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `Keeper venue not found: ${params.keeper_venue_id}` },
          ],
          isError: true,
        };
      }
      if (dup.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Duplicate venue not found: ${params.duplicate_venue_id}`,
            },
          ],
          isError: true,
        };
      }
      const dupRow = dup[0];
      if (dupRow.status === "INACTIVE") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Refused: duplicate venue is already INACTIVE (id=${dupRow.id}). Likely already merged.`,
            },
          ],
          isError: true,
        };
      }

      // 1. Reassign events.
      const reassignResult = await db
        .update(events)
        .set({ venueId: params.keeper_venue_id })
        .where(eq(events.venueId, params.duplicate_venue_id))
        .returning({ id: events.id });
      const reassignedCount = reassignResult.length;

      // 2. Tombstone the loser. Slug renamed to `*-merged-<id8>` so the
      // old slug becomes available for re-creation later if needed.
      const tombstoneSlug = unsafeSlug(`${dupRow.slug}-merged-${dupRow.id.slice(0, 8)}`);
      await db
        .update(venues)
        .set({ status: "INACTIVE", slug: tombstoneSlug, updatedAt: new Date() })
        .where(eq(venues.id, params.duplicate_venue_id));

      // 3. Audit trail.
      try {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "venue.merge",
          targetType: "venue",
          targetId: params.keeper_venue_id,
          actorUserId: auth.userId ?? null,
          payloadJson: JSON.stringify({
            keeper_id: params.keeper_venue_id,
            duplicate_id: params.duplicate_venue_id,
            duplicate_original_slug: dupRow.slug,
            duplicate_tombstone_slug: tombstoneSlug,
            events_reassigned: reassignedCount,
          }),
          createdAt: new Date(),
        });
      } catch {
        // Audit failure shouldn't fail the merge itself.
      }

      return {
        content: [
          jsonContent({
            merged: true,
            keeper_id: params.keeper_venue_id,
            duplicate_id: params.duplicate_venue_id,
            duplicate_original_slug: dupRow.slug,
            duplicate_tombstone_slug: tombstoneSlug,
            events_reassigned: reassignedCount,
            slug_history_written: false,
            slug_history_note:
              "Old slug will 404 instead of 301. Build venue_slug_history + middleware support for SEO-preserving redirects (follow-up).",
          }),
        ],
      };
    }
  );

  // ── merge_promoter ──────────────────────────────────────────────
  server.tool(
    "merge_promoter",
    "Merge two promoter rows. Reassigns all events from the duplicate to the keeper, then HARD-DELETES the duplicate (promoters has no soft-delete column). Safe because the FK cascade has nothing to cascade after reassignment. NO slug-history written (same gap as merge_venue). Refuses self-merge. Admin only.",
    {
      keeper_promoter_id: z
        .string()
        .min(1)
        .describe(
          "The promoter row to keep. All events pointing at the duplicate will be reassigned here."
        ),
      duplicate_promoter_id: z
        .string()
        .min(1)
        .describe(
          "The promoter row to retire. After merge: events reassigned, row hard-deleted (FK cascade has nothing left to cascade)."
        ),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Forbidden — admin only." }],
          isError: true,
        };
      }
      if (params.keeper_promoter_id === params.duplicate_promoter_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Refused: keeper and duplicate are the same promoter.",
            },
          ],
          isError: true,
        };
      }

      const [keeper, dup] = await Promise.all([
        db.select().from(promoters).where(eq(promoters.id, params.keeper_promoter_id)).limit(1),
        db.select().from(promoters).where(eq(promoters.id, params.duplicate_promoter_id)).limit(1),
      ]);
      if (keeper.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Keeper promoter not found: ${params.keeper_promoter_id}`,
            },
          ],
          isError: true,
        };
      }
      if (dup.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Duplicate promoter not found: ${params.duplicate_promoter_id}`,
            },
          ],
          isError: true,
        };
      }
      const dupRow = dup[0];

      // 1. Reassign events.
      const reassignResult = await db
        .update(events)
        .set({ promoterId: params.keeper_promoter_id })
        .where(eq(events.promoterId, params.duplicate_promoter_id))
        .returning({ id: events.id });
      const reassignedCount = reassignResult.length;

      // 2. Hard-delete the loser. FK cascade has nothing to cascade
      // since we already reassigned every event.
      await db.delete(promoters).where(eq(promoters.id, params.duplicate_promoter_id));

      // 3. Audit trail.
      try {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "promoter.merge",
          targetType: "promoter",
          targetId: params.keeper_promoter_id,
          actorUserId: auth.userId ?? null,
          payloadJson: JSON.stringify({
            keeper_id: params.keeper_promoter_id,
            duplicate_id: params.duplicate_promoter_id,
            duplicate_company_name: dupRow.companyName,
            duplicate_slug: dupRow.slug,
            events_reassigned: reassignedCount,
          }),
          createdAt: new Date(),
        });
      } catch {
        // Audit failure shouldn't fail the merge itself.
      }

      return {
        content: [
          jsonContent({
            merged: true,
            keeper_id: params.keeper_promoter_id,
            duplicate_id: params.duplicate_promoter_id,
            duplicate_company_name: dupRow.companyName,
            duplicate_slug: dupRow.slug,
            events_reassigned: reassignedCount,
            slug_history_written: false,
            slug_history_note:
              "Old slug will 404 instead of 301. Build promoter_slug_history + middleware support for SEO-preserving redirects (follow-up).",
          }),
        ],
      };
    }
  );
}
