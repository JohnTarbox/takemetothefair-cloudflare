/**
 * OPE-113 PR#2 — performer alias/merge D1 orchestration for the admin UI
 * (main-app side; mirrors the mcp-server `set_performer_alias` / `merge_performer`
 * tools). Extracted so the endpoints stay thin and this is unit-testable.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { performers, eventPerformers, performerSlugHistory } from "@/lib/db/schema";
import { unsafeSlug } from "@takemetothefair/utils";

/** WHERE for one appearance identity (NULL day/start matched explicitly). */
function appearanceWhere(
  eventId: string,
  performerId: string,
  eventDayId: string | null,
  performanceStart: Date | null
) {
  return and(
    eq(eventPerformers.eventId, eventId),
    eq(eventPerformers.performerId, performerId),
    eventDayId == null
      ? isNull(eventPerformers.eventDayId)
      : eq(eventPerformers.eventDayId, eventDayId),
    performanceStart == null
      ? isNull(eventPerformers.performanceStart)
      : eq(eventPerformers.performanceStart, performanceStart)
  );
}

/**
 * Mark `aliasId` as an alias of `canonicalId`: tombstone it (soft-delete + slug
 * rename so the canonical is free) + point redirect/alias at the canonical +
 * write slug-history so the old slug 301s. Does NOT move appearances (use merge).
 */
export async function aliasPerformer(
  db: Database,
  aliasId: string,
  canonicalId: string,
  changedBy: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (aliasId === canonicalId) return { ok: false, error: "self_alias" };
  const [alias] = await db.select().from(performers).where(eq(performers.id, aliasId)).limit(1);
  const [canon] = await db
    .select({ id: performers.id, slug: performers.slug })
    .from(performers)
    .where(eq(performers.id, canonicalId))
    .limit(1);
  if (!alias) return { ok: false, error: "alias_not_found" };
  if (!canon) return { ok: false, error: "canonical_not_found" };
  const now = new Date();
  const tombstone = unsafeSlug(`${alias.slug}-alias-${alias.id.slice(0, 8)}`);
  // slug-history maps the alias's ORIGINAL slug → the live CANONICAL slug (not the
  // tombstone) so middleware 301s old links to the canonical page (OPE-115 fix).
  await db.insert(performerSlugHistory).values({
    performerId: canonicalId,
    oldSlug: alias.slug,
    newSlug: canon.slug,
    changedAt: now,
    changedBy,
  });
  await db
    .update(performers)
    .set({
      aliasOfPerformerId: canonicalId,
      redirectToPerformerId: canonicalId,
      deletedAt: now,
      slug: tombstone,
      updatedAt: now,
    })
    .where(eq(performers.id, aliasId));
  return { ok: true };
}

const GAP_COLS = [
  "description",
  "website",
  "socialLinks",
  "imageUrl",
  "homeBaseCity",
  "homeBaseState",
  "contactName",
  "contactEmail",
  "contactPhone",
  "performerType",
  "actCategory",
] as const;

/**
 * Merge `dupId` into `keeperId`: move the duplicate's appearances to the keeper
 * (dropping any that would collide with a keeper slot), gap-fill empty keeper
 * fields from the duplicate, write slug-history (old dup slug → keeper), then
 * tombstone the duplicate.
 */
export async function mergePerformer(
  db: Database,
  keeperId: string,
  dupId: string,
  changedBy: string | null
): Promise<{ ok: true; moved: number; dropped: number } | { ok: false; error: string }> {
  if (keeperId === dupId) return { ok: false, error: "self_merge" };
  const [keeper] = await db.select().from(performers).where(eq(performers.id, keeperId)).limit(1);
  const [dup] = await db.select().from(performers).where(eq(performers.id, dupId)).limit(1);
  if (!keeper) return { ok: false, error: "keeper_not_found" };
  if (!dup) return { ok: false, error: "duplicate_not_found" };

  const dupAppearances = await db
    .select()
    .from(eventPerformers)
    .where(eq(eventPerformers.performerId, dupId));
  let moved = 0;
  let dropped = 0;
  for (const a of dupAppearances) {
    const clash = await db
      .select({ id: eventPerformers.id })
      .from(eventPerformers)
      .where(appearanceWhere(a.eventId, keeperId, a.eventDayId, a.performanceStart))
      .limit(1);
    if (clash.length > 0) {
      await db.delete(eventPerformers).where(eq(eventPerformers.id, a.id));
      dropped++;
    } else {
      await db
        .update(eventPerformers)
        .set({ performerId: keeperId, updatedAt: new Date() })
        .where(eq(eventPerformers.id, a.id));
      moved++;
    }
  }

  const keeperRec = keeper as unknown as Record<string, unknown>;
  const dupRec = dup as unknown as Record<string, unknown>;
  const gap: Record<string, unknown> = {};
  for (const col of GAP_COLS) {
    if ((keeperRec[col] == null || keeperRec[col] === "") && dupRec[col] != null)
      gap[col] = dupRec[col];
  }
  if (Object.keys(gap).length > 0) {
    gap.updatedAt = new Date();
    await db.update(performers).set(gap).where(eq(performers.id, keeperId));
  }

  const now = new Date();
  const tombstone = unsafeSlug(`${dup.slug}-merged-${dup.id.slice(0, 8)}`);
  // slug-history maps the duplicate's ORIGINAL slug → the live KEEPER slug (not the
  // tombstone) so middleware 301s old links to the keeper page (OPE-115 fix).
  await db.insert(performerSlugHistory).values({
    performerId: keeperId,
    oldSlug: dup.slug,
    newSlug: keeper.slug,
    changedAt: now,
    changedBy,
  });
  await db
    .update(performers)
    .set({
      deletedAt: now,
      redirectToPerformerId: keeperId,
      aliasOfPerformerId: keeperId,
      slug: tombstone,
      updatedAt: now,
    })
    .where(eq(performers.id, dupId));
  return { ok: true, moved, dropped };
}
