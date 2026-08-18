/**
 * OPE-294 — is this image ours, or are we hotlinking somebody else's server?
 *
 * 97.7% of venue images point at `lh3.googleusercontent.com` — Google Places
 * photos, served directly from Google's CDN onto our public venue pages. That
 * carries three separate problems, and only one of them is a decision for John:
 *
 *   licensing   Google Maps Platform terms restrict storing, caching and
 *               proxying Places photo content and require photographer
 *               attribution. ⚠️ NOT interpreted here — that read is John's, and
 *               nothing in this file assumes an answer.
 *   durability  Places photo URLs are not permanent asset URLs. When they
 *               rotate, 172 venue pages lose their image silently.
 *   pipeline    A third-party host cannot go through `/cdn-cgi/image/`, so
 *               these get no AVIF/WebP negotiation, no width ladder and no LCP
 *               control — on pages where the image IS the LCP element.
 *
 * ── What this file is for, and what it is careful not to be ──────────────
 *
 * It classifies. It does not delete, rewrite or re-host anything: the ticket is
 * explicit that re-hosting may be MORE restricted than hotlinking, so acting on
 * the existing rows before the licensing read could make the exposure worse.
 *
 * The measured problem is that the count grows silently. Between 2026-07-28 and
 * 2026-08-18 venue hotlinks went 172 → 173 and event hotlinks went **28 → 51**,
 * with the newest arriving the same day this was re-measured. Classification is
 * what lets a write path decline to add to that.
 */

/** Hosts whose bytes we control and can serve through the transform pipeline. */
export const OWNED_IMAGE_HOSTS = ["cdn.meetmeatthefair.com", "meetmeatthefair.com"] as const;

export type ImageHostKind =
  /** Ours: R2 behind the CDN, or a same-origin path. Transformable. */
  | "owned"
  /** Somebody else's server. Renders today; not ours to depend on. */
  | "third_party"
  /** Not a usable image reference at all. */
  | "invalid";

export interface ImageHostVerdict {
  kind: ImageHostKind;
  host: string | null;
  /** True for the Google Places CDN specifically — the population the ticket
   *  is about, and the one with a licensing question attached. */
  isGooglePlaces: boolean;
}

const GOOGLE_PLACES_HOSTS = [
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
];

/**
 * Classify an image reference by who serves it.
 *
 * A relative path is `owned` — it resolves against our own origin. An empty or
 * unparseable value is `invalid` rather than `third_party`, because "we have no
 * image" and "we are borrowing an image" are different facts and a caller will
 * want to treat them differently.
 */
export function classifyImageHost(url: string | null | undefined): ImageHostVerdict {
  const raw = (url ?? "").trim();
  if (raw.length === 0) return { kind: "invalid", host: null, isGooglePlaces: false };

  // Same-origin path — ours by definition.
  if (raw.startsWith("/")) return { kind: "owned", host: null, isGooglePlaces: false };

  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return { kind: "invalid", host: null, isGooglePlaces: false };
  }

  const isGooglePlaces = GOOGLE_PLACES_HOSTS.includes(host);
  const owned = (OWNED_IMAGE_HOSTS as readonly string[]).includes(host);
  return { kind: owned ? "owned" : "third_party", host, isGooglePlaces };
}

/** Convenience: would persisting this URL add to the hotlink population? */
export function isHotlinked(url: string | null | undefined): boolean {
  return classifyImageHost(url).kind === "third_party";
}
