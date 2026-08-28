/**
 * OPE-573 — a signup whose business name slugifies onto an existing listing.
 *
 * ## What actually happened, measured on prod 2026-08-27
 *
 * `/api/auth/register` minted `slug: createSlug(businessName)` straight into a
 * `notNull().unique()` column with no collision handling. On a collision D1
 * threw, the outer catch returned a generic 500 — and because the `users` and
 * `user_roles` inserts happen BEFORE the vendor insert with no transaction,
 * **the account was already created**. The person saw "An error occurred during
 * registration", and a retry told them the email was already taken.
 *
 * Three real accounts are in that state, each matching a logged collision to
 * the second:
 *
 *   21streetbeads@gmail.com          2026-08-26 06:16:43  → "21 Street Beads"
 *   Admin@kewlkandylz.com            2026-08-07 17:19:41  → "Kewl Kandylz"
 *   gooseberryleathercompany@gmail.com 2026-07-22 01:23:43 → "Gooseberry Leather Company"
 *
 * (The third predates the OPE-25/OPE-80 logging, which is why the ticket's
 * count of 2 was correctly filed as a floor rather than a total.)
 *
 * ## Why NOT auto-suffix, which is the obvious fix
 *
 * The ticket proposed `acme-crafts-2` and called it "probably correct, since
 * the user does not care about the slug". The prod data says otherwise: all
 * three collisions were against a listing **that already exists in our
 * directory** and describes that same business. Auto-suffixing would have
 * minted a duplicate of a real vendor and left the person owning the copy
 * rather than the original — a worse outcome than the 500, because it is
 * silent and it pollutes the directory.
 *
 * A name collision here is a strong signal the vendor is ALREADY listed and the
 * person should be claiming it. So this resolves the collision to the existing
 * listing and hands the caller what it needs to route into the claim flow.
 *
 * The generic `findUniqueSlug` helper in `@/lib/utils` stays right for events,
 * where two genuinely different fairs can share a name. It is the wrong tool
 * for an identity-bearing business listing.
 */
import { eq, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { vendors, promoters } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import { createSlug } from "@/lib/utils";
import { normalizeName, normalizedNameSql } from "@/lib/names/normalized-name";

type Db = DrizzleD1Database<typeof schema>;

export type CollisionEntityType = "VENDOR" | "PROMOTER";

export interface NameCollision {
  entityType: CollisionEntityType;
  /** The existing listing's slug. */
  slug: string;
  /** Its display name, so the caller can say which listing it means. */
  name: string;
  /** Whether somebody has already claimed it — changes the message, not the route. */
  claimed: boolean;
  /** Where to send the person: the claim wizard for this listing. */
  claimUrl: string;
}

/**
 * Does `rawName` slugify onto an existing vendor/promoter listing?
 *
 * Returns the collision, or null when the name is free. An empty slug (a name
 * of only punctuation) returns null — that is the caller's validation problem,
 * not a collision, and `createSlug` yielding "" must never match a real row.
 */
export async function findNameCollision(
  db: Db,
  entityType: CollisionEntityType,
  rawName: string
): Promise<NameCollision | null> {
  const slug = createSlug(rawName);
  if (!slug) return null;

  // OPE-600 — slug equality is not sufficient, because a stored slug is
  // whatever the generator emitted the day the row was created.
  //
  // `createSlug` has changed since. Two divergence classes are confirmed
  // against the live generator: `&` now becomes `-and-` (stored
  // `golder-stone-garden`, current `golder-stone-and-garden`) and an
  // apostrophe is now dropped rather than hyphenated (stored
  // `ben-s-tackle-shack`, current `bens-tackle-shack`). 67 + 58 vendor rows
  // respectively, all predating the generator change.
  //
  // For every one of those, the slug lookup found nothing, the insert hit the
  // UNIQUE index anyway, and the person got the generic 500 with no claim link
  // — the exact experience OPE-573 shipped this helper to remove, silently and
  // indistinguishably from the pre-fix bug.
  //
  // The name fallback sidesteps the whole question of WHICH generator wrote the
  // row: it compares what the business is called, which does not change when
  // the slugifier does. Third appearance of this family — it was root-caused on
  // venues in PR #257 and the fallback was not generalised then.
  const normalized = normalizeName(rawName);

  if (entityType === "VENDOR") {
    const [row] = await db
      .select({ slug: vendors.slug, name: vendors.businessName, claimed: vendors.claimed })
      .from(vendors)
      .where(
        or(eq(vendors.slug, slug), sql`${normalizedNameSql(vendors.businessName)} = ${normalized}`)
      )
      .limit(1);
    if (!row) return null;
    return {
      entityType,
      slug: row.slug,
      name: row.name,
      claimed: Boolean(row.claimed),
      claimUrl: `/claim/vendor/${row.slug}`,
    };
  }

  const [row] = await db
    .select({ slug: promoters.slug, name: promoters.companyName, claimed: promoters.claimed })
    .from(promoters)
    .where(
      or(eq(promoters.slug, slug), sql`${normalizedNameSql(promoters.companyName)} = ${normalized}`)
    )
    .limit(1);
  if (!row) return null;
  return {
    entityType,
    slug: row.slug,
    name: row.name,
    claimed: Boolean(row.claimed),
    claimUrl: `/claim/promoter/${row.slug}`,
  };
}

/**
 * The message the person actually reads. Deliberately says the listing already
 * exists rather than "that name is taken" — the second reads as a naming rule
 * and invites them to pick "21 Street Beads LLC", which is exactly the
 * duplicate we are trying to avoid.
 */
export function nameCollisionMessage(collision: NameCollision): string {
  const kind = collision.entityType === "VENDOR" ? "business" : "organization";
  return collision.claimed
    ? `“${collision.name}” is already listed and claimed. If this is your ${kind}, you can request access to the existing listing.`
    : `“${collision.name}” is already listed on the site. If this is your ${kind}, claim the existing listing instead of creating a second one.`;
}

/**
 * Is this the D1 UNIQUE-constraint failure we convert into a 409?
 *
 * Only the backstop path uses this. The pre-flight lookup catches every
 * real-world case; this exists for the narrow race where two signups with the
 * same name pass the check together, and for any future writer that forgets
 * the pre-flight.
 *
 * ⚠️ Matched on the driver's message text because that is all D1 gives us — it
 * surfaces no error code. Kept deliberately broad (`UNIQUE constraint failed`)
 * rather than pinned to a column name, since a narrower match that silently
 * stopped matching would fail OPEN: back to a 500 and an orphaned account.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /UNIQUE constraint failed/i.test(msg);
}
