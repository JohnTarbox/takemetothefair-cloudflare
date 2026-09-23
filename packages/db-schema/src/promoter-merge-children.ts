/**
 * OPE-1120 — what a promoter merge must do to the loser's rows that the
 * database will not do for it.
 *
 * Both merge paths (the `merge_promoter` MCP tool and the app's
 * /api/admin/duplicates/merge) reassigned `events.promoter_id` and then
 * HARD-DELETED the loser. Every table that points at promoters WITHOUT a
 * declared FK was left holding the dead id: measured 2026-09-22, 24
 * `promoter_enrichment_candidates` (20 still `pending` in the review queue,
 * proposing values for a promoter that no longer exists), 5
 * `pending_search_pings`, 2 `image_coverage_state` rows.
 *
 * One function, called by BOTH paths before the delete, so a fix here cannot
 * reach one path and miss the other — the shape of the original defect.
 *
 * Deliberately NOT touched: `enrichment_log` — a log keeps the historical id.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Staged enrichment field → the promoter column it would write. Same six the
 * enrichment dispatch and review tools map (both keep a private copy).
 */
export const PROMOTER_ENRICHMENT_FIELD_TO_COLUMN = {
  hero: "heroImageUrl",
  logo: "logoUrl",
  description: "description",
  social_links: "socialLinks",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
} as const satisfies Record<string, keyof typeof schema.promoters.$inferSelect>;

/** Marker written to `reviewed_by` on candidates a merge had to decide. */
export const PROMOTER_MERGE_REVIEWER = "system:promoter-merge";

export interface PromoterChildRepointResult {
  /** Pending candidates moved to the keeper — the keeper's field was still empty. */
  candidatesRetargeted: number;
  /** Pending candidates rejected — the keeper already has a value; moving them would overwrite it. */
  candidatesRejected: number;
  /** Already-decided candidates repointed so their history stays attached to a live promoter. */
  candidatesHistoryRepointed: number;
  /** Search pings repointed (the entity_slug keeps the OLD url, which now 301s — still worth pinging). */
  pingsRepointed: number;
  /** The loser's image-coverage row, deleted — the next scan measures the keeper itself. */
  coverageRowsDeleted: number;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "" || v.trim() === "[]" || v.trim() === "{}";
  return false;
}

export async function repointPromoterChildren(
  db: Db,
  keeperId: string,
  loserId: string,
  now: Date = new Date()
): Promise<PromoterChildRepointResult> {
  const out: PromoterChildRepointResult = {
    candidatesRetargeted: 0,
    candidatesRejected: 0,
    candidatesHistoryRepointed: 0,
    pingsRepointed: 0,
    coverageRowsDeleted: 0,
  };

  const [keeper] = await db
    .select()
    .from(schema.promoters)
    .where(eq(schema.promoters.id, keeperId))
    .limit(1);
  if (!keeper) throw new Error(`repointPromoterChildren: keeper ${keeperId} not found`);

  const candidates = await db
    .select({
      id: schema.promoterEnrichmentCandidates.id,
      field: schema.promoterEnrichmentCandidates.proposedField,
      decision: schema.promoterEnrichmentCandidates.decision,
    })
    .from(schema.promoterEnrichmentCandidates)
    .where(eq(schema.promoterEnrichmentCandidates.promoterId, loserId));

  // OPE-1120 — fields the KEEPER already has a pending proposal for.
  // `idx_pec_pending_field` is UNIQUE (promoter_id, proposed_field) WHERE
  // decision='pending', so retargeting a second pending row onto the keeper
  // throws and takes the whole merge down with it. Found during the step-4
  // cleanup: #656 (logo) could not move to lowell-folk-festival, which already
  // held its own pending logo #2551. The keeper's own proposal wins; the
  // loser's is rejected, like any proposal the keeper would clash with.
  const keeperPending = new Set(
    (
      await db
        .select({ field: schema.promoterEnrichmentCandidates.proposedField })
        .from(schema.promoterEnrichmentCandidates)
        .where(
          and(
            eq(schema.promoterEnrichmentCandidates.promoterId, keeperId),
            eq(schema.promoterEnrichmentCandidates.decision, "pending")
          )
        )
    ).map((r) => r.field)
  );

  const retarget: number[] = [];
  const reject: number[] = [];
  const history: number[] = [];
  for (const c of candidates) {
    if (c.decision !== "pending") {
      history.push(c.id);
      continue;
    }
    const column =
      PROMOTER_ENRICHMENT_FIELD_TO_COLUMN[
        c.field as keyof typeof PROMOTER_ENRICHMENT_FIELD_TO_COLUMN
      ];
    // An unknown field has no column to protect: move it and let review decide.
    const keeperValue = column ? (keeper as Record<string, unknown>)[column] : null;
    if (isEmpty(keeperValue) && !keeperPending.has(c.field)) {
      retarget.push(c.id);
      // Two loser rows for one field would collide with each other too.
      keeperPending.add(c.field);
    } else reject.push(c.id);
  }

  // Integer ids, chunked well under D1's 100-bound-parameter cap.
  const chunks = (ids: number[]) => {
    const r: number[][] = [];
    for (let i = 0; i < ids.length; i += 90) r.push(ids.slice(i, i + 90));
    return r;
  };
  for (const ids of chunks([...retarget, ...history])) {
    await db
      .update(schema.promoterEnrichmentCandidates)
      .set({ promoterId: keeperId })
      .where(inArray(schema.promoterEnrichmentCandidates.id, ids));
  }
  for (const ids of chunks(reject)) {
    await db
      .update(schema.promoterEnrichmentCandidates)
      .set({
        promoterId: keeperId,
        decision: "rejected",
        reviewedAt: now,
        reviewedBy: PROMOTER_MERGE_REVIEWER,
      })
      .where(inArray(schema.promoterEnrichmentCandidates.id, ids));
  }
  out.candidatesRetargeted = retarget.length;
  out.candidatesRejected = reject.length;
  out.candidatesHistoryRepointed = history.length;

  const pings = await db
    .update(schema.pendingSearchPings)
    .set({ entityId: keeperId })
    .where(
      and(
        sql`lower(${schema.pendingSearchPings.entityType}) = 'promoter'`,
        eq(schema.pendingSearchPings.entityId, loserId)
      )
    )
    .returning({ id: schema.pendingSearchPings.id });
  out.pingsRepointed = pings.length;

  const coverage = await db
    .delete(schema.imageCoverageState)
    .where(
      and(
        // Case-insensitive: the enum says PROMOTER, but the orphan audit that
        // found these queried lower(entity_type), and a guard that misses a
        // lower-cased row is the defect this function exists to close.
        sql`lower(${schema.imageCoverageState.entityType}) = 'promoter'`,
        eq(schema.imageCoverageState.entityId, loserId)
      )
    )
    .returning({ id: schema.imageCoverageState.entityId });
  out.coverageRowsDeleted = coverage.length;

  return out;
}

/**
 * OPE-1125 — a plain DELETE has no keeper to repoint to, so the loser's
 * FK-less rows are removed instead of orphaned. Only ever called for a promoter
 * that owns ZERO events (the route refuses otherwise), so what is removed is
 * proposals and bookkeeping for an entity that is going away — never content.
 * `enrichment_log` is left alone, as on merge.
 */
export async function deletePromoterChildren(
  db: Db,
  promoterId: string
): Promise<{ candidatesDeleted: number; pingsDeleted: number; coverageRowsDeleted: number }> {
  const candidates = await db
    .delete(schema.promoterEnrichmentCandidates)
    .where(eq(schema.promoterEnrichmentCandidates.promoterId, promoterId))
    .returning({ id: schema.promoterEnrichmentCandidates.id });
  const pings = await db
    .delete(schema.pendingSearchPings)
    .where(
      and(
        sql`lower(${schema.pendingSearchPings.entityType}) = 'promoter'`,
        eq(schema.pendingSearchPings.entityId, promoterId)
      )
    )
    .returning({ id: schema.pendingSearchPings.id });
  const coverage = await db
    .delete(schema.imageCoverageState)
    .where(
      and(
        sql`lower(${schema.imageCoverageState.entityType}) = 'promoter'`,
        eq(schema.imageCoverageState.entityId, promoterId)
      )
    )
    .returning({ id: schema.imageCoverageState.entityId });
  return {
    candidatesDeleted: candidates.length,
    pingsDeleted: pings.length,
    coverageRowsDeleted: coverage.length,
  };
}
