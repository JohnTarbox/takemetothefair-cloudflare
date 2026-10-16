/**
 * OPE-1373 — one rename path for promoter / venue / vendor slugs, app and MCP.
 *
 * ## The defect this closes
 *
 * `src/middleware.ts` 301s a renamed URL by walking `*_slug_history`. OPE-495 /
 * OPE-518 wired that history into the MCP `update_promoter` / `update_venue`
 * tools, but the three APP paths that rename the same rows wrote nothing:
 *
 *   - PATCH /api/admin/promoters/[id]   (no collision loop either — a rename
 *     onto a taken slug hit the UNIQUE index and returned a 500)
 *   - PATCH /api/admin/venues/[id]
 *   - POST  /api/admin/venues/google-backfill  (renames from Google's name)
 *
 * so an admin rename 404'd the old URL. That is the "fix wired into one of two
 * parallel paths" shape: each surface kept its own copy of the collision loop
 * and its own (or no) history insert.
 *
 * ## The shape
 *
 * `planSlugRename()` resolves the collision-safe slug against the entity's
 * UNIQUE column AND hands back the history INSERT for it. The caller writes
 * `plan.nextSlug` into its UPDATE and runs `plan.historyInsert` in the SAME
 * `db.batch()` — so the rename and its redirect commit together or not at all.
 * A plan is `null` when the slug would not change, so a no-op edit never writes
 * a junk history row.
 *
 * A source-level guard asserts every slug assignment on these three entities'
 * update paths goes through here: see
 * `src/__tests__/slug-rename-guard-ope1373.test.ts`.
 */
import { and, eq, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { SLUG_CANDIDATE_ATTEMPTS, slugCandidates, type Slug } from "@takemetothefair/utils";
import * as schema from "./index";

type Db = DrizzleD1Database<typeof schema>;

export type SlugRenameEntity = "promoter" | "venue" | "vendor";

/** Every candidate slug in the bounded sequence was already taken. */
export class SlugCollisionExhaustedError extends Error {
  constructor(
    readonly entity: SlugRenameEntity,
    readonly seed: Slug,
    readonly attempts: number
  ) {
    super(`No free ${entity} slug for "${seed}" after ${attempts} candidates`);
    this.name = "SlugCollisionExhaustedError";
  }
}

async function slugTakenByOther(
  db: Db,
  entity: SlugRenameEntity,
  candidate: Slug,
  selfId: string
): Promise<boolean> {
  let rows: { id: string }[];
  if (entity === "promoter") {
    rows = await db
      .select({ id: schema.promoters.id })
      .from(schema.promoters)
      .where(and(eq(schema.promoters.slug, candidate), ne(schema.promoters.id, selfId)))
      .limit(1);
  } else if (entity === "venue") {
    rows = await db
      .select({ id: schema.venues.id })
      .from(schema.venues)
      .where(and(eq(schema.venues.slug, candidate), ne(schema.venues.id, selfId)))
      .limit(1);
  } else {
    rows = await db
      .select({ id: schema.vendors.id })
      .from(schema.vendors)
      .where(and(eq(schema.vendors.slug, candidate), ne(schema.vendors.id, selfId)))
      .limit(1);
  }
  return rows.length > 0;
}

/**
 * The first slug in `slugCandidates(seed)` (seed, seed-2, seed-3, …) that no
 * OTHER row of `entity` holds. Throws `SlugCollisionExhaustedError` rather than
 * inventing a slug when the bounded sequence runs out.
 */
export async function resolveUniqueSlug(
  db: Db,
  entity: SlugRenameEntity,
  seed: Slug,
  selfId: string,
  maxAttempts: number = SLUG_CANDIDATE_ATTEMPTS
): Promise<Slug> {
  for (const candidate of slugCandidates(seed, maxAttempts)) {
    if (!(await slugTakenByOther(db, entity, candidate, selfId))) return candidate;
  }
  throw new SlugCollisionExhaustedError(entity, seed, maxAttempts);
}

export interface SlugHistoryRow {
  entityId: string;
  oldSlug: Slug;
  newSlug: Slug;
  changedAt: Date;
  changedBy: string | null;
}

/**
 * The `*_slug_history` INSERT for one rename, unexecuted — await it, or (better)
 * put it in the same `db.batch()` as the UPDATE that changes the slug.
 */
export function slugHistoryInsert(
  db: Db,
  entity: SlugRenameEntity,
  row: SlugHistoryRow
): BatchItem<"sqlite"> {
  const common = {
    oldSlug: row.oldSlug,
    newSlug: row.newSlug,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
  };
  if (entity === "promoter") {
    return db.insert(schema.promoterSlugHistory).values({ promoterId: row.entityId, ...common });
  }
  if (entity === "venue") {
    return db.insert(schema.venueSlugHistory).values({ venueId: row.entityId, ...common });
  }
  return db.insert(schema.vendorSlugHistory).values({ vendorId: row.entityId, ...common });
}

export interface SlugRenameInput {
  entityId: string;
  /** The row's slug as it stands before this write. */
  currentSlug: Slug;
  /** The desired slug before collision resolution, e.g. `createSlug(newName)`. */
  seed: Slug | null | undefined;
  changedBy: string | null;
  changedAt?: Date;
  maxAttempts?: number;
}

export interface SlugRenamePlan {
  previousSlug: Slug;
  /** Collision-safe; write this into the UPDATE's `slug`. */
  nextSlug: Slug;
  /** Run in the same batch as the UPDATE so the redirect cannot be lost. */
  historyInsert: BatchItem<"sqlite">;
}

/**
 * Plan a slug rename: `null` when nothing would change (no seed, or the seed
 * resolves back to the current slug), otherwise the collision-safe slug plus
 * its history INSERT.
 */
export async function planSlugRename(
  db: Db,
  entity: SlugRenameEntity,
  input: SlugRenameInput
): Promise<SlugRenamePlan | null> {
  const { entityId, currentSlug, seed, changedBy } = input;
  if (!seed || seed === currentSlug) return null;
  const nextSlug = await resolveUniqueSlug(db, entity, seed, entityId, input.maxAttempts);
  if (nextSlug === currentSlug) return null;
  return {
    previousSlug: currentSlug,
    nextSlug,
    historyInsert: slugHistoryInsert(db, entity, {
      entityId,
      oldSlug: currentSlug,
      newSlug: nextSlug,
      changedAt: input.changedAt ?? new Date(),
      changedBy,
    }),
  };
}
