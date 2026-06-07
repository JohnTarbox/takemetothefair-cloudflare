/**
 * IMG1 (2026-06-07) — URL-based Cloudflare Image Resizing helper.
 *
 * Builds `https://meetmeatthefair.com/cdn-cgi/image/<params>/<src>` URLs
 * for render-time derivatives (responsive srcSet, sized og:image,
 * gravity-aware hero crops). Pairs with `src/lib/image-loader.ts`, which
 * is the Next/Image custom loader that calls `cdnImage()` per request.
 *
 * Why URL-based Image Resizing (not Cloudflare Images the paid product):
 *   - The upload pipeline (`src/lib/image-optim.ts`) already uses `cf.image`
 *     URL resizing in production to produce the 2000px WebP master. The
 *     zone already has Image Resizing enabled — no new binding, no monthly
 *     cost, no new image-IDs to manage.
 *   - The dev-handoff doc names "Cloudflare Images" but the substantive
 *     ask (derivatives + `gravity=auto` smart-crop) is identical between
 *     the two products, and URL Resizing keeps the bundle slim post-PR
 *     #333 (which retired /api/og to fit the 25 MiB Worker cap).
 *
 * `gravity` modes supported by `cdn-cgi/image` per Cloudflare's docs:
 *   - `auto` — content-aware saliency crop (the §1b spec default for the
 *     ~81% scraped images that have no human-picked focal point)
 *   - `face` — face-detection crop (best for headshots / avatars)
 *   - `center` / `top` / `bottom` / `left` / `right` — manual anchors
 *
 * Foreign hosts (OAuth avatars at `lh3.googleusercontent.com` etc.) are
 * returned unchanged — `cdn-cgi/image` only proxies same-zone assets
 * and trying to route foreign URLs through it 404s. The Next/Image
 * loader still emits a srcSet for them, just with the same bare URL at
 * each width; harmless.
 */

export type CdnImageFit = "cover" | "contain" | "scale-down" | "crop" | "pad";

export type CdnImageGravity = "auto" | "face" | "center" | "top" | "bottom" | "left" | "right";

export type CdnImageFormat = "auto" | "webp" | "avif" | "jpg" | "png";

export interface CdnImageOpts {
  width: number;
  height?: number;
  fit?: CdnImageFit;
  /**
   * Subject anchor for `fit=cover` crops. `auto` is the §1b spec
   * default for scraped images; use `face` for avatars / logos that
   * benefit from face detection.
   */
  gravity?: CdnImageGravity;
  format?: CdnImageFormat;
  quality?: number;
}

// Hosts whose URLs we can transform via Cloudflare's same-zone
// `cdn-cgi/image` proxy. Foreign hosts pass through unchanged.
const TRANSFORMABLE_PREFIXES = ["https://cdn.meetmeatthefair.com/", "https://meetmeatthefair.com/"];

/**
 * Wrap an image URL with a `cdn-cgi/image/<params>/...` transform.
 *
 * Returns the bare URL for:
 *   - null/empty input (caller handles fallback)
 *   - foreign hosts (no proxy available)
 *   - URLs that already include `/cdn-cgi/image/` (avoid double-wrap)
 *
 * @example
 *   cdnImage("https://cdn.meetmeatthefair.com/events/abc/hero.webp", OG_EVENT)
 *   // → "https://meetmeatthefair.com/cdn-cgi/image/width=1200,height=630,fit=cover,gravity=auto,format=auto/https://cdn.meetmeatthefair.com/events/abc/hero.webp"
 */
export function cdnImage(src: string | null | undefined, opts: CdnImageOpts): string {
  if (!src) return "";
  if (src.includes("/cdn-cgi/image/")) return src;
  const isTransformable = TRANSFORMABLE_PREFIXES.some((p) => src.startsWith(p));
  if (!isTransformable) return src;

  const params: string[] = [`width=${opts.width}`];
  if (opts.height != null) params.push(`height=${opts.height}`);
  if (opts.fit) params.push(`fit=${opts.fit}`);
  if (opts.gravity) params.push(`gravity=${opts.gravity}`);
  if (opts.format) params.push(`format=${opts.format}`);
  if (opts.quality != null) params.push(`quality=${opts.quality}`);

  return `https://meetmeatthefair.com/cdn-cgi/image/${params.join(",")}/${src}`;
}

// ---------- Canonical derivative-size presets ----------
// Module-level constants so any caller emitting an og:image, hero,
// or thumbnail gets a consistent transform footprint. Adjusting one
// ratio updates every consumer in one place.

/** 16:9 hero — matches the EventDetail spec §1b canonical ratio. */
export const HERO_DESKTOP = {
  width: 1600,
  height: 900,
  fit: "cover",
  gravity: "auto",
  format: "auto",
} satisfies CdnImageOpts;

export const HERO_MOBILE = {
  width: 800,
  height: 450,
  fit: "cover",
  gravity: "auto",
  format: "auto",
} satisfies CdnImageOpts;

/** Open Graph 1.91:1 — Facebook/LinkedIn/Slack canonical preview ratio. */
export const OG_EVENT = {
  width: 1200,
  height: 630,
  fit: "cover",
  gravity: "auto",
  format: "auto",
} satisfies CdnImageOpts;

/**
 * Square OG variant for vendor/promoter logos — many vendor "images"
 * are square logos and would crop badly into 1200×630. The square
 * variant looks correct in Slack/iMessage previews and OK on FB/LI
 * (they letterbox instead of cropping).
 */
export const OG_SQUARE = {
  width: 1200,
  height: 1200,
  fit: "cover",
  gravity: "auto",
  format: "auto",
} satisfies CdnImageOpts;

/** 3:2 listing-card thumbnail — used by EventCard and the search row. */
export const CARD_THUMB = {
  width: 600,
  height: 400,
  fit: "cover",
  gravity: "auto",
  format: "auto",
} satisfies CdnImageOpts;

/** Small avatar — `face` gravity for OAuth headshots and vendor logos. */
export const AVATAR_SM = {
  width: 80,
  height: 80,
  fit: "cover",
  gravity: "face",
  format: "auto",
} satisfies CdnImageOpts;
