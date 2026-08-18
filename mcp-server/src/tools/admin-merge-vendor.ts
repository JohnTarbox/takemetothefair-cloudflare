/**
 * OPE-451 scope 3 — `merge_vendor`.
 *
 * Vendors were the ONLY major entity without a merge tool: `merge_events`,
 * `merge_venue`, `merge_promoter` and `merge_performer` all existed. They are
 * also the entity most exposed to bulk duplicate creation, because roster
 * backfills mint them 60 at a time through `create_or_link_vendor`. So an
 * agent that noticed it had just created a duplicate had no way to fix it —
 * and correctly refused to `delete_vendor` a live row that might carry links.
 * Duplicates accumulated with no path out short of a hand-written D1 write.
 *
 * Mirrors merge_venue's reassign-then-tombstone shape, with three differences
 * that are specific to vendors:
 *
 * 1. **`event_vendors` has TWO unique indexes** — `idx_eventvendors_series_unique`
 *    and `idx_eventvendors_perday_unique`. A blind
 *    `UPDATE event_vendors SET vendor_id = keeper` therefore FAILS the moment
 *    both vendors are linked to the same event, which is the common case: a
 *    duplicate is usually created while linking the very event the keeper is
 *    already on. (The reported pair, `dc755ad9`, was linked to `defe4089`
 *    alongside its keeper.) `merge_venue` never hits this because `events` has
 *    no such constraint. Colliding links are DROPPED, not transferred, and
 *    counted separately in the result so the operator sees it happened.
 *
 * 2. **Vendors carry four self-referential pointers** — `redirect_to_vendor_id`,
 *    `brand_parent_vendor_id`, `operator_parent_vendor_id`, `alias_of_vendor_id`.
 *    OTHER vendor rows may point at the duplicate through any of them; left
 *    alone they would aim at a tombstone. All four are repointed at the keeper.
 *
 * 3. **The tombstone sets `redirect_to_vendor_id = keeper`.** Vendors already
 *    have a redirect-chain resolver (`resolveRedirectChain` in
 *    @takemetothefair/vendor-linking), so a later `create_or_link_vendor` that
 *    matches the dead row automatically lands on the keeper. That is the
 *    vendor equivalent of `events.merged_into`, and it is why this merge also
 *    protects future writes rather than only past ones.
 *
 * The 301 comes from `vendor_slug_history`, walked in
 * src/app/vendors/[slug]/page.tsx (NOT middleware, unlike events/venues).
 *
 * `preview: true` (the DEFAULT) performs every read and NO write, returning the
 * transfer counts and warnings. Defaulting to preview is deliberate: this is a
 * destructive write on live public rows, and the ticket that requested the tool
 * also requires operator sign-off before any real merge.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  vendors,
  eventVendors,
  vendorPhotos,
  vendorSlugHistory,
  vendorSelfReportedEvents,
  vendorClaimEvidence,
  vendorEnrichmentCandidates,
  vendorOutreachAttempts,
  entityClaims,
  contentLinks,
  userFavorites,
  adminActions,
} from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { jsonContent, unsafeSlug } from "../helpers.js";

/**
 * D1 caps a statement at 100 bound parameters (OPE-241), so every `inArray`
 * here is chunked. Not theoretical for this tool: a busy vendor can carry more
 * than 100 event links, and the merge would fail at exactly the moment it is
 * most needed. CI's bound-param guard caught this before it shipped.
 */
const BIND_CHUNK = 90;
function chunk<T>(items: T[], size = BIND_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Rows on the duplicate that would collide with the keeper's existing links. */
async function planEventVendorTransfer(db: Db, keeperId: string, duplicateId: string) {
  const dupLinks = await db
    .select({
      id: eventVendors.id,
      eventId: eventVendors.eventId,
      eventDayId: eventVendors.eventDayId,
    })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, duplicateId));

  const keeperLinks = await db
    .select({ eventId: eventVendors.eventId, eventDayId: eventVendors.eventDayId })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, keeperId));

  // The unique indexes are on (event_id, vendor_id) for series-wide rows and
  // (event_id, vendor_id, event_day_id) for per-day rows, so the collision key
  // must include the day.
  const keeperKeys = new Set(keeperLinks.map((l) => `${l.eventId}::${l.eventDayId ?? ""}`));

  const transferable: string[] = [];
  const colliding: string[] = [];
  for (const link of dupLinks) {
    const key = `${link.eventId}::${link.eventDayId ?? ""}`;
    if (keeperKeys.has(key)) colliding.push(link.id);
    else {
      transferable.push(link.id);
      // A duplicate linked to the SAME event twice would otherwise collide with
      // itself mid-transfer.
      keeperKeys.add(key);
    }
  }
  return { transferable, colliding, dupLinkCount: dupLinks.length };
}

export function registerMergeVendorTool(server: McpServer, db: Db, auth: AuthContext) {
  server.tool(
    "merge_vendor",
    "Merge two vendor rows. Transfers event links, photos, claims, content links, favourites and enrichment/outreach history from the duplicate to the keeper; repoints other vendors' brand/operator/alias/redirect pointers; writes a vendor_slug_history row so the old /vendors/<slug> 301-redirects; then tombstones the duplicate (soft-deleted, slug renamed, redirect_to_vendor_id → keeper). Event links that would collide with a link the keeper already has are DROPPED and reported, because event_vendors is uniquely indexed on (event_id, vendor_id). Defaults to preview: true — pass preview: false to actually write. Refuses self-merge and an already-merged duplicate. Admin only.",
    {
      keeper_vendor_id: z.string().min(1).describe("The vendor row to keep."),
      duplicate_vendor_id: z
        .string()
        .min(1)
        .describe("The vendor row to retire. Soft-deleted and pointed at the keeper."),
      preview: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "DEFAULTS TRUE. Reads everything and writes nothing, returning the transfer counts and warnings. Pass false to commit — this is a destructive write on live public rows."
        ),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Forbidden — admin only." }],
          isError: true,
        };
      }
      const { keeper_vendor_id: keeperId, duplicate_vendor_id: duplicateId } = params;
      const preview = params.preview ?? true;

      if (keeperId === duplicateId) {
        return {
          content: [
            { type: "text" as const, text: "Refused: keeper and duplicate are the same vendor." },
          ],
          isError: true,
        };
      }

      const [keeperRows, dupRows] = await Promise.all([
        db.select().from(vendors).where(eq(vendors.id, keeperId)).limit(1),
        db.select().from(vendors).where(eq(vendors.id, duplicateId)).limit(1),
      ]);
      if (keeperRows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Keeper vendor not found: ${keeperId}` }],
          isError: true,
        };
      }
      if (dupRows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Duplicate vendor not found: ${duplicateId}` }],
          isError: true,
        };
      }
      const keeper = keeperRows[0];
      const dup = dupRows[0];

      if (dup.redirectToVendorId || dup.deletedAt) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Refused: duplicate vendor ${duplicateId} is already merged or deleted (redirect_to_vendor_id=${dup.redirectToVendorId ?? "null"}, deleted_at=${dup.deletedAt ? "set" : "null"}).`,
            },
          ],
          isError: true,
        };
      }
      // Merging INTO a tombstone would leave the keeper unreachable.
      if (keeper.redirectToVendorId || keeper.deletedAt) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Refused: keeper vendor ${keeperId} is itself merged or deleted. Merge into the canonical row instead.`,
            },
          ],
          isError: true,
        };
      }

      const plan = await planEventVendorTransfer(db, keeperId, duplicateId);

      const countOf = async (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        table: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: any
      ): Promise<number> => {
        const rows = await db
          .select({ n: sql<number>`count(*)` })
          .from(table)
          .where(where);
        return Number(rows[0]?.n ?? 0);
      };

      const [photos, selfReported, claimEvidence, enrichment, outreach, claims, links, favourites] =
        await Promise.all([
          countOf(vendorPhotos, eq(vendorPhotos.vendorId, duplicateId)),
          countOf(vendorSelfReportedEvents, eq(vendorSelfReportedEvents.vendorId, duplicateId)),
          countOf(vendorClaimEvidence, eq(vendorClaimEvidence.vendorId, duplicateId)),
          countOf(vendorEnrichmentCandidates, eq(vendorEnrichmentCandidates.vendorId, duplicateId)),
          countOf(vendorOutreachAttempts, eq(vendorOutreachAttempts.vendorId, duplicateId)),
          countOf(
            entityClaims,
            and(eq(entityClaims.entityType, "VENDOR"), eq(entityClaims.entityId, duplicateId))
          ),
          countOf(
            contentLinks,
            and(eq(contentLinks.targetType, "VENDOR"), eq(contentLinks.targetId, duplicateId))
          ),
          countOf(
            userFavorites,
            and(
              eq(userFavorites.favoritableType, "VENDOR"),
              eq(userFavorites.favoritableId, duplicateId)
            )
          ),
        ]);

      // Other vendor rows pointing AT the duplicate.
      const childRefs = await db
        .select({ id: vendors.id })
        .from(vendors)
        .where(
          sql`(${vendors.brandParentVendorId} = ${duplicateId}
             OR ${vendors.operatorParentVendorId} = ${duplicateId}
             OR ${vendors.aliasOfVendorId} = ${duplicateId}
             OR ${vendors.redirectToVendorId} = ${duplicateId})`
        );

      const warnings: string[] = [];
      if (plan.colliding.length > 0) {
        warnings.push(
          `${plan.colliding.length} event link(s) will be DROPPED, not transferred: the keeper is already linked to those events. event_vendors is uniquely indexed on (event_id, vendor_id).`
        );
      }
      if (dup.claimed) {
        warnings.push(
          `The duplicate is CLAIMED (claimed_by=${dup.claimedBy ?? "unknown"}). A real person owns this row — confirm with them before merging.`
        );
      }
      if (dup.verifiedPro) {
        warnings.push("The duplicate is verified-pro; the keeper does not inherit that flag.");
      }
      if (childRefs.length > 0) {
        warnings.push(
          `${childRefs.length} other vendor row(s) point at the duplicate via brand/operator/alias/redirect and will be repointed at the keeper.`
        );
      }

      const summary = {
        keeper: { id: keeper.id, name: keeper.businessName, slug: keeper.slug },
        duplicate: { id: dup.id, name: dup.businessName, slug: dup.slug },
        transfers: {
          event_links_transferred: plan.transferable.length,
          event_links_dropped_as_duplicate: plan.colliding.length,
          photos,
          self_reported_events: selfReported,
          claim_evidence: claimEvidence,
          enrichment_candidates: enrichment,
          outreach_attempts: outreach,
          entity_claims: claims,
          content_links: links,
          favourites,
          vendor_pointers_repointed: childRefs.length,
        },
        warnings,
      };

      if (preview) {
        return {
          content: [
            jsonContent({
              ...summary,
              preview: true,
              merged: false,
              note: "Nothing was written. Re-run with preview: false to commit.",
            }),
          ],
        };
      }

      // ── Writes ──────────────────────────────────────────────────────
      // Ordered so a failure part-way leaves the duplicate still reachable:
      // the tombstone is LAST. D1 has no interactive transaction here, so the
      // safe failure mode is "some rows transferred, duplicate still live"
      // (a re-run finishes the job) rather than "duplicate dead, rows orphaned".
      for (const batch of chunk(plan.transferable)) {
        await db
          .update(eventVendors)
          .set({ vendorId: keeperId })
          .where(inArray(eventVendors.id, batch));
      }
      for (const batch of chunk(plan.colliding)) {
        await db.delete(eventVendors).where(inArray(eventVendors.id, batch));
      }

      await Promise.all([
        db
          .update(vendorPhotos)
          .set({ vendorId: keeperId })
          .where(eq(vendorPhotos.vendorId, duplicateId)),
        db
          .update(vendorSelfReportedEvents)
          .set({ vendorId: keeperId })
          .where(eq(vendorSelfReportedEvents.vendorId, duplicateId)),
        db
          .update(vendorClaimEvidence)
          .set({ vendorId: keeperId })
          .where(eq(vendorClaimEvidence.vendorId, duplicateId)),
        db
          .update(vendorEnrichmentCandidates)
          .set({ vendorId: keeperId })
          .where(eq(vendorEnrichmentCandidates.vendorId, duplicateId)),
        db
          .update(vendorOutreachAttempts)
          .set({ vendorId: keeperId })
          .where(eq(vendorOutreachAttempts.vendorId, duplicateId)),
        db
          .update(entityClaims)
          .set({ entityId: keeperId })
          .where(
            and(eq(entityClaims.entityType, "VENDOR"), eq(entityClaims.entityId, duplicateId))
          ),
        db
          .update(contentLinks)
          .set({ targetId: keeperId })
          .where(
            and(eq(contentLinks.targetType, "VENDOR"), eq(contentLinks.targetId, duplicateId))
          ),
      ]);

      // Favourites: a user may already favourite BOTH rows, and re-pointing
      // would give them the keeper twice in their dashboard. Move only the
      // ones that would not duplicate; drop the rest.
      const dupFavourites = await db
        .select({ id: userFavorites.id, userId: userFavorites.userId })
        .from(userFavorites)
        .where(
          and(
            eq(userFavorites.favoritableType, "VENDOR"),
            eq(userFavorites.favoritableId, duplicateId)
          )
        );
      if (dupFavourites.length > 0) {
        const keeperFavourites = await db
          .select({ userId: userFavorites.userId })
          .from(userFavorites)
          .where(
            and(
              eq(userFavorites.favoritableType, "VENDOR"),
              eq(userFavorites.favoritableId, keeperId)
            )
          );
        const already = new Set(keeperFavourites.map((f) => f.userId));
        const movable = dupFavourites.filter((f) => !already.has(f.userId)).map((f) => f.id);
        const droppable = dupFavourites.filter((f) => already.has(f.userId)).map((f) => f.id);
        for (const batch of chunk(movable)) {
          await db
            .update(userFavorites)
            .set({ favoritableId: keeperId })
            .where(inArray(userFavorites.id, batch));
        }
        for (const batch of chunk(droppable)) {
          await db.delete(userFavorites).where(inArray(userFavorites.id, batch));
        }
      }

      // Repoint other vendors' pointers off the tombstone.
      if (childRefs.length > 0) {
        // No id list needed: each `eq` already selects exactly the rows pointing
        // at the duplicate through that column. Carrying an `inArray` of the
        // pre-read ids as well was redundant AND unbounded — it would have blown
        // D1's 100-parameter cap on a vendor with many children.
        await Promise.all([
          db
            .update(vendors)
            .set({ brandParentVendorId: keeperId })
            .where(eq(vendors.brandParentVendorId, duplicateId)),
          db
            .update(vendors)
            .set({ operatorParentVendorId: keeperId })
            .where(eq(vendors.operatorParentVendorId, duplicateId)),
          db
            .update(vendors)
            .set({ aliasOfVendorId: keeperId })
            .where(eq(vendors.aliasOfVendorId, duplicateId)),
          db
            .update(vendors)
            .set({ redirectToVendorId: keeperId })
            .where(eq(vendors.redirectToVendorId, duplicateId)),
        ]);
      }

      // Slug history BEFORE the rename, pointing at the KEEPER's id so a future
      // hard-delete of the tombstone cannot cascade this row away.
      try {
        await db.insert(vendorSlugHistory).values({
          vendorId: keeperId,
          oldSlug: dup.slug,
          newSlug: keeper.slug,
          changedAt: new Date(),
          changedBy: auth.userId ?? null,
        });
      } catch {
        // Idempotent re-run — a history row may already exist.
      }

      // Tombstone last.
      const tombstoneSlug = unsafeSlug(`${dup.slug}-merged-${dup.id.slice(0, 8)}`);
      await db
        .update(vendors)
        .set({
          slug: tombstoneSlug,
          redirectToVendorId: keeperId,
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(vendors.id, duplicateId));

      try {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "vendor.merge",
          targetType: "vendor",
          targetId: keeperId,
          actorUserId: auth.userId ?? null,
          payloadJson: JSON.stringify({
            keeper_id: keeperId,
            duplicate_id: duplicateId,
            duplicate_original_slug: dup.slug,
            duplicate_tombstone_slug: tombstoneSlug,
            ...summary.transfers,
            warnings,
          }),
          createdAt: new Date(),
        });
      } catch {
        // Audit failure must not fail the merge.
      }

      return {
        content: [
          jsonContent({
            ...summary,
            preview: false,
            merged: true,
            duplicate_tombstone_slug: tombstoneSlug,
            redirect: `/vendors/${dup.slug} → /vendors/${keeper.slug}`,
          }),
        ],
      };
    }
  );
}

/** Exported for tests — the collision planner is the part with real logic. */
export { planEventVendorTransfer };
