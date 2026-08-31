/**
 * OPE-686 — the rules the gallery maintenance surface needs, in one place.
 *
 * Pure: no database, no clock, no fetch. The two galleries (event and vendor)
 * are the same shape, and every rule here has to hold for both — a fix wired
 * into one of two parallel paths is the defect this codebase keeps
 * rediscovering, so the rules live once and both callers import them.
 */

/** The only rotations `cdn-cgi/image` accepts, and the only ones worth having. */
export const ALLOWED_ROTATIONS = [0, 90, 180, 270] as const;
export type GalleryRotation = (typeof ALLOWED_ROTATIONS)[number];

export function isGalleryRotation(n: number): n is GalleryRotation {
  return (ALLOWED_ROTATIONS as readonly number[]).includes(n);
}

/**
 * Apply a relative turn to a stored rotation.
 *
 * Relative, not absolute, because that is how the operator thinks: they see a
 * sideways photo and want it turned a quarter turn. Storing the ABSOLUTE angle
 * and asking the caller to compute it would mean every caller needs to read the
 * current value first, and the one that forgets silently un-rotates a photo
 * somebody already fixed.
 *
 * Normalises negatives too: -90 is a legitimate way to say "turn it back".
 */
export function applyRotation(current: number, degrees: number): GalleryRotation {
  const next = (((current + degrees) % 360) + 360) % 360;
  if (!isGalleryRotation(next)) {
    throw new Error(
      `Rotation must land on 0, 90, 180 or 270 — ${current} + ${degrees} gives ${next}.`
    );
  }
  return next;
}

/**
 * The `rotate` value to put in a `cdn-cgi/image` options string, or undefined.
 *
 * Undefined at 0 rather than `rotate=0`, and that is not cosmetic: the options
 * string IS the CDN cache key, so emitting `rotate=0` on every unrotated image
 * would invalidate every derivative already cached for the entire site the
 * moment this shipped. Same reasoning as `focalPointGravity` returning
 * undefined for the (0.5, 0.5) centre default.
 */
export type AppliedRotation = Exclude<GalleryRotation, 0>;

export function rotationCdnOption(
  rotation: number | null | undefined
): AppliedRotation | undefined {
  if (rotation == null) return undefined;
  const norm = ((rotation % 360) + 360) % 360;
  // The 0 case is excluded from the RETURN TYPE, not merely from the branch.
  // "We never emit rotate=0" is a cache-correctness invariant, so the compiler
  // should be the thing enforcing it at every call site.
  if (norm === 0 || !isGalleryRotation(norm)) return undefined;
  return norm as AppliedRotation;
}

export interface GalleryPhotoLike {
  id: string;
  sortOrder: number;
  isFeatured: boolean;
  deletedAt?: Date | null;
}

/**
 * Which photo becomes featured when the featured one is deleted.
 *
 * Returns null when nothing should change — either the deleted photo was not
 * the featured one, or there is nothing left to promote.
 *
 * A gallery whose lead photo is deleted and left headless renders with no
 * featured image at all, which on the public page is indistinguishable from a
 * gallery nobody has curated. Promoting the next one keeps the surface honest
 * without asking the operator to remember a second step.
 *
 * "Next" is the lowest remaining `sort_order`, ties broken by id so the choice
 * is deterministic. A random tiebreak would make the same delete produce
 * different galleries on retry, which is exactly the kind of thing that makes
 * an idempotent-looking operation untestable.
 */
export function pickFeaturedSuccessor<T extends GalleryPhotoLike>(
  photos: readonly T[],
  deletedId: string
): T | null {
  const deleted = photos.find((p) => p.id === deletedId);
  if (!deleted || !deleted.isFeatured) return null;

  const remaining = photos
    .filter((p) => p.id !== deletedId && !p.deletedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return remaining[0] ?? null;
}

/**
 * SHA-256 of the bytes, lowercase hex — the dedup key.
 *
 * Hashes the bytes AS STORED, after any resize/re-encode. Hashing the upload
 * instead would miss the case the incident actually produced: the same source
 * photo submitted twice, arriving with different EXIF or a different filename
 * and normalising to identical stored bytes.
 *
 * `crypto.subtle` is available in Workers and in Node 18+, so this is the same
 * function on both artifacts.
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
