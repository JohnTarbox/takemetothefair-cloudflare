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
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { vendors, promoters } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import { createSlug } from "@/lib/utils";

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

  if (entityType === "VENDOR") {
    const [row] = await db
      .select({ slug: vendors.slug, name: vendors.businessName, claimed: vendors.claimed })
      .from(vendors)
      .where(eq(vendors.slug, slug))
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
    .where(eq(promoters.slug, slug))
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
