/**
 * OPE-1480 — fill `venues.accessibility` / `venues.parking` from Google, so the
 * OPE-1479 "About the venue (from Google)" line has something to say.
 *
 * Three states per column, and the write rule keeps them apart:
 *   NULL / ""   never fetched — fill it
 *   "{}"        fetched, Google holds none — may be upgraded by a later fetch
 *   non-empty   Google's options — NEVER replaced by an empty answer
 *
 * Called from the creation path (`geocodeNewVenue`), the geocode sweep, and the
 * one-off backfill route — one rule, not three (the OPE-408 lesson: a tool that
 * is not wired into the path that creates the gap leaves the gap growing).
 */
import { eq } from "drizzle-orm";
import { venues } from "@/lib/db/schema";
import { fetchPlaceAccessParking } from "@/lib/google-maps";
import { recordMutation } from "@/lib/audit/record-mutation";

const isUnfetched = (v: string | null | undefined) => v == null || v.trim() === "";
const isEmptyAnswer = (v: string | null | undefined) => {
  if (isUnfetched(v)) return true;
  try {
    const o: unknown = JSON.parse(v as string);
    return !o || typeof o !== "object" || Object.keys(o as object).length === 0;
  } catch {
    return false; // unparseable stored text is not ours to overwrite
  }
};

/** The column writes a fetched answer may make. Pure. */
export function amenityFillUpdates(
  current: { accessibility: string | null; parking: string | null },
  fetched: { accessibility: string; parking: string }
): { accessibility?: string; parking?: string } {
  const out: { accessibility?: string; parking?: string } = {};
  for (const k of ["accessibility", "parking"] as const) {
    const cur = current[k];
    const next = fetched[k];
    if (isUnfetched(cur))
      out[k] = next; // first answer, including "{}"
    else if (isEmptyAnswer(cur) && !isEmptyAnswer(next)) out[k] = next; // {} → data
  }
  return out;
}

/** Venues this filler still has something to do for. */
export function needsAmenityFill(row: {
  accessibility: string | null;
  parking: string | null;
}): boolean {
  return isUnfetched(row.accessibility) || isUnfetched(row.parking);
}

export type AmenityFillResult =
  | { status: "filled"; columns: string[] }
  | { status: "unchanged" | "no-place-id" | "fetch-failed" | "not-needed" };

/**
 * Fetch + fill one venue. `refetchEmpty` also re-asks Google for a column that
 * holds "{}" (the backfill uses it; the creation path does not need to).
 */
export async function fillVenueGoogleAmenities(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  venueId: string,
  apiKey: string,
  opts: { actor: string; refetchEmpty?: boolean; dryRun?: boolean } = {
    actor: "venue-amenity-fill",
  }
): Promise<AmenityFillResult> {
  const [row] = await db
    .select({
      googlePlaceId: venues.googlePlaceId,
      accessibility: venues.accessibility,
      parking: venues.parking,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  if (!row?.googlePlaceId) return { status: "no-place-id" };
  const wanted =
    needsAmenityFill(row) ||
    (opts.refetchEmpty === true &&
      (isEmptyAnswer(row.accessibility) || isEmptyAnswer(row.parking)));
  if (!wanted) return { status: "not-needed" };
  if (opts.dryRun) return { status: "unchanged" };

  const fetched = await fetchPlaceAccessParking(row.googlePlaceId, apiKey);
  if (!fetched) return { status: "fetch-failed" };
  const updates = amenityFillUpdates(row, fetched);
  const columns = Object.keys(updates);
  if (columns.length === 0) return { status: "unchanged" };

  await db
    .update(venues)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(venues.id, venueId));
  await recordMutation(db, {
    entityType: "venue",
    entityId: venueId,
    verb: "update",
    actor: opts.actor,
    before: { accessibility: row.accessibility, parking: row.parking },
    after: updates,
    note: "google-amenities:fill",
  });
  return { status: "filled", columns };
}
