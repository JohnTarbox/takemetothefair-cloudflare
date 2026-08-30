/**
 * OPE-212 §3/§4 — the READ path for `event_photos`.
 *
 * Mirror of `src/lib/vendor-photos.ts`, minus the legacy fallback: events have
 * never had a JSON gallery column, so there is nothing to fall back to. That
 * asymmetry is the ONLY difference, and it is a property of the data rather
 * than a design choice.
 *
 * Like the vendor table, `event_photos` shipped in increment 1 (PR #741,
 * migration 0161) and has never been read by anything.
 *
 * ── `events.image_url` stays the canonical hero ───────────────────────────
 *
 * John's greenlight is explicit: "existing `events.image_url` remains the
 * canonical hero; gallery `is_featured` is only its own lead." So this reader
 * never returns the hero as a gallery photo and never overrides it — the two
 * are separate slots. OPE-204/205's "hero-if-blank" writes target `image_url`,
 * which is why a gallery photo structurally cannot clobber an existing hero.
 */
import { asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { eventPhotos } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export interface EventGalleryPhoto {
  id: string;
  url: string;
  /** Never empty — see `resolvePhotoAlt`. */
  alt: string;
  caption?: string;
  isFeatured: boolean;
}

/**
 * The alt text to render, never blank.
 *
 * John's guardrail: "`alt` text required — the gallery UI must require alt on
 * upload. Fallback to caption if alt is blank. Never emit an empty `alt`."
 *
 * An empty `alt=""` on a content image is not neutral — it tells a screen
 * reader the image is decorative and to skip it, which is a lie about a photo
 * of the fair. The final fallback names the event so the announcement is at
 * worst generic rather than absent.
 */
export function resolvePhotoAlt(
  alt: string | null | undefined,
  caption: string | null | undefined,
  eventName: string
): string {
  const trimmedAlt = alt?.trim();
  if (trimmedAlt) return trimmedAlt;
  const trimmedCaption = caption?.trim();
  if (trimmedCaption) return trimmedCaption;
  return `Photo from ${eventName}`;
}

/** Featured first, then stored order. Same rule as the vendor gallery. */
export function orderEventPhotos<T extends { isFeatured: boolean }>(photos: T[]): T[] {
  return [...photos].sort((a, b) => {
    if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
    return 0;
  });
}

export async function getEventGallery(
  db: Db,
  eventId: string,
  eventName: string
): Promise<EventGalleryPhoto[]> {
  const rows = await db
    .select({
      id: eventPhotos.id,
      url: eventPhotos.photoUrl,
      alt: eventPhotos.altText,
      caption: eventPhotos.caption,
      isFeatured: eventPhotos.isFeatured,
    })
    .from(eventPhotos)
    .where(eq(eventPhotos.eventId, eventId))
    .orderBy(asc(eventPhotos.sortOrder));

  return orderEventPhotos(
    rows.map((r) => ({
      id: r.id,
      url: r.url,
      alt: resolvePhotoAlt(r.alt, r.caption, eventName),
      caption: r.caption ?? undefined,
      isFeatured: !!r.isFeatured,
    }))
  );
}

/**
 * The `image` value for Event JSON-LD.
 *
 * Google accepts a string, an array of strings, or ImageObject(s). John
 * approved: "`ImageObject` array in Event JSON-LD when >1 photo exists
 * (single-image events keep the current shape)."
 *
 * That conditional is the important part. Changing every event's `image` to an
 * array would be a schema change on ~thousands of pages to no benefit, and a
 * needless re-crawl of correct markup. Only events that actually gained photos
 * change shape.
 *
 * The hero leads the array — it is the canonical image, and the first entry is
 * the one Google is most likely to surface.
 */
export function buildEventSchemaImages(
  heroUrl: string,
  gallery: readonly { url: string; alt: string; caption?: string }[]
): string | Array<Record<string, string>> {
  if (gallery.length === 0) return heroUrl;

  const seen = new Set<string>([heroUrl]);
  const extras = gallery.filter((p) => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  // Every gallery photo duplicated the hero — nothing to add, so keep the
  // scalar shape rather than emitting a one-element array.
  if (extras.length === 0) return heroUrl;

  return [
    { "@type": "ImageObject", url: heroUrl },
    ...extras.map((p) => ({
      "@type": "ImageObject",
      url: p.url,
      // `caption` is the schema.org property; alt is an HTML concept. Emitting
      // alt text as a caption would put "Photo from X Fair" in front of a
      // reader as if the photographer wrote it, so only a real caption is sent.
      ...(p.caption ? { caption: p.caption } : {}),
    })),
  ];
}
