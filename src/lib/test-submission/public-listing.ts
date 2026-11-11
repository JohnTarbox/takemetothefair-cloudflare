/**
 * OPE-1625 — what a test report may say about an existing listing.
 *
 * The projection is an explicit allow-list of public columns (slug, name,
 * series path inputs, the public-visibility gate). Nothing here reads a
 * contact, an internal note, a submitter or a private column, so a match
 * report cannot leak one however it is assembled.
 */
import { eq } from "drizzle-orm";
import { SITE_URL, isPubliclyVisible } from "@takemetothefair/constants";
import { eventCanonicalPath } from "@takemetothefair/utils";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { eventSeries, events } from "@/lib/db/schema";
import type { FieldChange, PublicListing } from "./types";

type Db = ReturnType<typeof getCloudflareDb>;

/**
 * The fields a match may show as old → new. Exactly the import diff's
 * (`diffAgainstEvent`) fields, every one of which the public event page shows.
 * A field outside this list is dropped, never shown.
 */
export const PUBLIC_DIFF_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "start_date",
  "end_date",
  "description",
  "vendor_application_url",
  "application_deadline",
  "booth_fee_min",
  "booth_fee_max",
  "admission_min",
  "admission_max",
  "event_url",
  "image_url",
  // A cancellation request's proposed status (the API's cancel dry run).
  "status",
  "reason",
]);

export interface ListingView extends PublicListing {
  /** Whether the caller may see this listing's field values (public, or the caller's own). */
  showValues: boolean;
}

/**
 * The public face of one event. Not public → no URL and no name, unless the
 * caller owns the event (the promoter API's own PENDING listing), in which case
 * the name and values are theirs to see but there is still no public URL.
 */
export async function publicListing(
  db: Db,
  eventId: string,
  opts: { ownerPromoterId?: string | null } = {}
): Promise<ListingView> {
  const [e] = await db
    .select({
      slug: events.slug,
      name: events.name,
      status: events.status,
      lifecycle: events.lifecycleStatus,
      startDate: events.startDate,
      editionKey: events.editionKey,
      promoterId: events.promoterId,
      seriesSlug: eventSeries.canonicalSlug,
      editionMode: eventSeries.editionMode,
    })
    .from(events)
    .leftJoin(eventSeries, eq(events.seriesId, eventSeries.id))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!e) return { url: null, name: null, public: false, showValues: false };
  const isPublic = isPubliclyVisible(e.status, e.lifecycle ?? "SCHEDULED");
  const own = !!opts.ownerPromoterId && e.promoterId === opts.ownerPromoterId;
  if (!isPublic) return { url: null, name: own ? e.name : null, public: false, showValues: own };
  return {
    url: `${SITE_URL}${eventCanonicalPath({
      slug: e.slug,
      seriesSlug: e.seriesSlug,
      startDate: e.startDate,
      editionMode: e.editionMode,
      editionKey: e.editionKey,
    })}`,
    name: e.name,
    public: true,
    showValues: true,
  };
}

/** A `{field: {current, proposed}}` diff → the list a report shows, public fields only. */
export function publicChanges(
  diff: Record<string, { current: string | null; proposed: string | null }> | undefined,
  listing: ListingView
): FieldChange[] {
  if (!diff || !listing.showValues) return [];
  return Object.entries(diff)
    .filter(([field]) => PUBLIC_DIFF_FIELDS.has(field))
    .map(([field, v]) => ({ field, current: v.current, proposed: v.proposed }));
}
