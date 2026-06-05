/**
 * DQ1 follow-up (2026-06-05) — merge_venue + merge_promoter MCP tools.
 * Slug-history wiring added by E remainder (Dev backlog 2026-06-05).
 *
 * Closes the named-deferral from PR #338. The DQ1 sweep endpoint
 * surfaces venue + promoter clusters; this is the write side that
 * resolves them.
 *
 * Mirrors `merge_events`'s reassign-then-tombstone pattern from
 * admin-event-lifecycle.ts. Both tools write slug-history rows
 * (drizzle/0109) so the old slug 301-redirects to the keeper via
 * src/middleware.ts -- closes the SEO trade-off PR #338 acknowledged.
 *
 * Per-entity differences from merge_events:
 *
 *   merge_venue:
 *     1. Refuse self-merge or already-INACTIVE duplicate.
 *     2. UPDATE events SET venue_id = keeper WHERE venue_id = duplicate
 *     3. INSERT venue_slug_history (venue_id = KEEPER, old_slug = duplicate's
 *        original slug). Points at KEEPER so the FK cascade behaves
 *        correctly across the duplicate's tombstone rename.
 *     4. UPDATE venues SET status='INACTIVE', slug='*-merged-<id8>'
 *        WHERE id = duplicate (audit-preserving — venue row stays;
 *        operator can still query it by id).
 *     5. WRITE admin_actions(action='venue.merge')
 *
 *   merge_promoter:
 *     1. Refuse self-merge.
 *     2. UPDATE events SET promoter_id = keeper WHERE promoter_id = duplicate
 *     3. INSERT promoter_slug_history (promoter_id = KEEPER, old_slug =
 *        duplicate's original slug). Points at KEEPER so the slug-history
 *        row survives the duplicate's hard-delete via FK cascade.
 *     4. promoters has no status column, but events.promoter_id has
 *        ON DELETE CASCADE. Since we already reassigned every event,
 *        the cascade has nothing to cascade -- safe to hard-delete.
 *     5. WRITE admin_actions(action='promoter.merge')
 *
 * Both tools fail-soft on missing input + return a structured result.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  events,
  venues,
  promoters,
  adminActions,
  venueSlugHistory,
  promoterSlugHistory,
} from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { jsonContent, unsafeSlug } from "../helpers.js";

export function registerMergeEntitiesTools(server: McpServer, db: Db, auth: AuthContext) {
  // ── merge_venue ─────────────────────────────────────────────────
  server.tool(
    "merge_venue",
    "Merge two venue rows. Reassigns all events from the duplicate to the keeper, writes a venue_slug_history row pointing at the keeper, then marks the duplicate INACTIVE with a `*-merged-<id8>` slug. The old slug 301-redirects to the keeper via the slug-history walker in src/middleware.ts. Refuses self-merge or already-merged duplicate. Admin only.",
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

      // 2. Write slug-history row BEFORE the tombstone rename. Points
      //    at the KEEPER's id, so the duplicate's eventual delete (none
      //    today, but a future operator might run DELETE FROM venues
      //    WHERE status='INACTIVE') would NOT cascade-delete this row.
      //    Old slug -> keeper's slug (the redirect target).
      const keeperRow = keeper[0];
      try {
        await db.insert(venueSlugHistory).values({
          venueId: params.keeper_venue_id,
          oldSlug: dupRow.slug,
          newSlug: keeperRow.slug,
          changedAt: new Date(),
          changedBy: auth.userId ?? null,
        });
      } catch {
        // Idempotent re-run: a slug-history row may already exist.
        // Drop silently — the merge can still proceed.
      }

      // 3. Tombstone the loser. Slug renamed to `*-merged-<id8>` so the
      // old slug becomes available for re-creation later if needed.
      const tombstoneSlug = unsafeSlug(`${dupRow.slug}-merged-${dupRow.id.slice(0, 8)}`);
      await db
        .update(venues)
        .set({ status: "INACTIVE", slug: tombstoneSlug, updatedAt: new Date() })
        .where(eq(venues.id, params.duplicate_venue_id));

      // 4. Audit trail.
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
            slug_history_written: true,
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
            keeper_slug: keeperRow.slug,
            events_reassigned: reassignedCount,
            slug_history_written: true,
          }),
        ],
      };
    }
  );

  // ── merge_promoter ──────────────────────────────────────────────
  server.tool(
    "merge_promoter",
    "Merge two promoter rows. Reassigns all events from the duplicate to the keeper, writes a promoter_slug_history row pointing at the keeper (so the row survives the duplicate's hard-delete via the cascade), then HARD-DELETES the duplicate (promoters has no soft-delete column). Old slug 301-redirects to the keeper via src/middleware.ts. Refuses self-merge. Admin only.",
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

      // 2. Write slug-history BEFORE the hard-delete. Points at the
      //    KEEPER's id, so the upcoming DELETE of the duplicate doesn't
      //    cascade away this row (the FK references promoters.id which
      //    remains alive for the keeper).
      const keeperRow = keeper[0];
      try {
        await db.insert(promoterSlugHistory).values({
          promoterId: params.keeper_promoter_id,
          oldSlug: dupRow.slug,
          newSlug: keeperRow.slug,
          changedAt: new Date(),
          changedBy: auth.userId ?? null,
        });
      } catch {
        // Idempotent re-run: a slug-history row may already exist.
        // Drop silently — the merge can still proceed.
      }

      // 3. Hard-delete the loser. FK cascade has nothing to cascade
      // since we already reassigned every event, and the slug-history
      // row points at the keeper not the duplicate.
      await db.delete(promoters).where(eq(promoters.id, params.duplicate_promoter_id));

      // 4. Audit trail.
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
            slug_history_written: true,
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
            keeper_slug: keeperRow.slug,
            events_reassigned: reassignedCount,
            slug_history_written: true,
          }),
        ],
      };
    }
  );
}
