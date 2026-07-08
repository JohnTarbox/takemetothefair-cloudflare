/**
 * OPE-122 — public performer index data + filter helpers.
 *
 * listPublicPerformers: the browsable set for /performers. Excludes soft-deleted
 * (deleted_at), merge tombstones (redirect_to_performer_id), and the merged-away
 * slugs (`*-merged-<id8>`), mirroring the exclusions the sitemap/middleware use.
 *
 * filterPerformers: pure client-side name + category filter (kept here so it's
 * unit-testable without rendering the browser component).
 */
import { and, asc, isNull, notLike } from "drizzle-orm";
import { performers } from "@/lib/db/schema";
import type { Database } from "@/lib/db";

export interface PublicPerformer {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  actCategory: string | null;
  homeBaseCity: string | null;
  homeBaseState: string | null;
  verified: boolean;
}

/** Human labels for the free-text act_category values (mirrors the detail page). */
export const PERFORMER_CATEGORY_LABEL: Record<string, string> = {
  MUSIC: "Music",
  ANIMAL_SHOW: "Animal show",
  MAGIC: "Magic",
  COMEDY: "Comedy",
  CIRCUS: "Circus",
  DANCE: "Dance",
  THEATER: "Theater",
  EDUCATIONAL: "Educational",
  CHILDRENS: "Children's",
  DEMONSTRATION: "Demonstration",
  OTHER: "Entertainment",
};

export async function listPublicPerformers(db: Database): Promise<PublicPerformer[]> {
  return db
    .select({
      id: performers.id,
      name: performers.name,
      slug: performers.slug,
      imageUrl: performers.imageUrl,
      actCategory: performers.actCategory,
      homeBaseCity: performers.homeBaseCity,
      homeBaseState: performers.homeBaseState,
      verified: performers.verified,
    })
    .from(performers)
    .where(
      and(
        isNull(performers.deletedAt),
        isNull(performers.redirectToPerformerId),
        notLike(performers.slug, "%-merged-%")
      )
    )
    .orderBy(asc(performers.name));
}

/** Case-insensitive name search + exact act_category match. Both optional. */
export function filterPerformers(
  list: PublicPerformer[],
  query: string,
  category: string | null
): PublicPerformer[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (p) =>
      (q === "" || p.name.toLowerCase().includes(q)) &&
      (category === null || p.actCategory === category)
  );
}
