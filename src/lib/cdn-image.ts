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

/**
 * Cloudflare `cdn-cgi/image` `gravity` values.
 *
 * Named modes (`auto` / `face` / `center` / etc.) per Cloudflare docs.
 *
 * The branded `CustomGravity` string carries a per-image focal point in
 * Cloudflare's `${x}x${y}` syntax (e.g. `"0.3x0.7"` = 30% from left, 70%
 * from top). Use `focalPointGravity(x, y)` to construct one; it returns
 * `undefined` for the (0.5, 0.5) center default so the cache key stays
 * identical to `gravity`-omitted URLs (avoids invalidating the entire
 * derivative cache on rollout).
 *
 * See https://developers.cloudflare.com/images/transform-images/transform-via-url/
 * §gravity for the full reference.
 */
export type CdnImageNamedGravity = "auto" | "face" | "center" | "top" | "bottom" | "left" | "right";

/** Branded type for custom focal-point coords `${x}x${y}`. */
export type CdnImageCustomGravity = `${number}x${number}`;

export type CdnImageGravity = CdnImageNamedGravity | CdnImageCustomGravity;

/**
 * Clamp `n` to [0, 1] and round to 3 decimal places — enough precision
 * for sub-pixel focal points without blowing out the URL cache key with
 * floating-point noise (`0.49999999` vs `0.5` would otherwise produce
 * separate CDN cache entries).
 */
function clampFocal(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  const clamped = Math.max(0, Math.min(1, n));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Build a `gravity=${x}x${y}` value for a per-image focal point, OR
 * return `undefined` to signal "use Cloudflare default (center)".
 *
 * Returning `undefined` for the center default is intentional: it means
 * the URL emitted by `cdnImage()` doesn't include a `gravity` segment
 * for events at (0.5, 0.5), matching the URL shape pre-IMG1 §1b. So the
 * rollout of this feature doesn't invalidate the entire Cloudflare
 * derivative cache (which would otherwise re-bill ~10K transformations
 * on first hit per image).
 *
 * The (0.5, 0.5) short-circuit also means operators who never set a
 * focal point pay zero cache-key cost.
 */
export function focalPointGravity(
  x: number | null | undefined,
  y: number | null | undefined
): CdnImageCustomGravity | undefined {
  const fx = clampFocal(x ?? 0.5);
  const fy = clampFocal(y ?? 0.5);
  if (fx === 0.5 && fy === 0.5) return undefined;
  return `${fx}x${fy}` as CdnImageCustomGravity;
}

export type CdnImageFormat = "auto" | "webp" | "avif" | "jpg" | "png";

/**
 * Behavior when the transform itself fails (source 404, oversized input,
 * monthly free-tier exhausted, etc.). `redirect` issues a 307 to the
 * un-transformed source URL — the browser still sees an image (the
 * original bytes) instead of a broken `<img>`. The only currently
 * documented value is `redirect`; modeled as a literal so a typo
 * doesn't silently disable the fallback.
 *
 * Default in `src/lib/image-loader.ts` sets this on every Next/Image
 * call — see the loader for the rationale.
 */
export type CdnImageOnError = "redirect";

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
  /** Graceful fallback when the transform fails; see {@link CdnImageOnError}. */
  onerror?: CdnImageOnError;
}

// Hosts whose URLs we can transform via Cloudflare's same-zone
// `cdn-cgi/image` proxy. Foreign hosts route through host-specific
// resize (see foreignHostResize below) when one is known, else pass
// through unchanged.
const TRANSFORMABLE_PREFIXES = ["https://cdn.meetmeatthefair.com/", "https://meetmeatthefair.com/"];

/**
 * Google's `lh{3,4,5,6}.googleusercontent.com` user-content URLs (Place
 * Photos, OAuth avatars, Drive images) accept a trailing size suffix —
 * `=wN` for width, `=sN` for square, `=hN` for height, with optional
 * combos like `=s4800-w800-c`. Replacing the existing suffix or appending
 * a fresh `=wWIDTH` gets us a resized variant for free, host-side.
 *
 * This is the only foreign-host case we optimize today. Without it the
 * blurred-fill backdrop (which only needs ~200px) would download the
 * full-res source every page render — significant on venue detail pages
 * where ~80% of `image_url` values point at Google Place Photos returning
 * 4800x2400 images.
 *
 * See https://developers.google.com/people/image-sizing (similar pattern
 * documented for People API) — the `=wN` syntax is host-wide convention
 * for googleusercontent.com.
 */
function isGoogleUserContent(url: string): boolean {
  return /\/\/lh[3-6]\.googleusercontent\.com\//.test(url);
}

function googleUserContentResize(src: string, width: number): string {
  // Match an existing trailing size param block: =[swh]N(-[swhc][N|=])*
  // Examples: `=s4800`, `=w800`, `=s4800-w800`, `=w200-c`, `=s400-c`
  const sizeRegex = /=[swh][0-9]+(-[a-z0-9]+)*$/i;
  if (sizeRegex.test(src)) {
    return src.replace(sizeRegex, `=w${width}`);
  }
  // No existing suffix — append. Google parses `=wN` at URL end as a
  // size hint on any user-content path.
  return src + `=w${width}`;
}

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
  if (!isTransformable) {
    // Foreign host. Some have host-side resize conventions we can use
    // (Google user content via `=wN`). Others pass through unchanged.
    //
    // The width-only resize is enough for the dominant foreign-host use
    // case today: blurred-fill backdrops (~200w). For foreground hero
    // and card renders the foreign-host URL still serves at source size,
    // which is acceptable — the size hint is best-effort, not lossless
    // through the same Cloudflare optimization pipeline.
    if (isGoogleUserContent(src)) {
      return googleUserContentResize(src, opts.width);
    }
    return src;
  }

  const params: string[] = [`width=${opts.width}`];
  if (opts.height != null) params.push(`height=${opts.height}`);
  if (opts.fit) params.push(`fit=${opts.fit}`);
  if (opts.gravity) params.push(`gravity=${opts.gravity}`);
  if (opts.format) params.push(`format=${opts.format}`);
  if (opts.quality != null) params.push(`quality=${opts.quality}`);
  if (opts.onerror) params.push(`onerror=${opts.onerror}`);

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
