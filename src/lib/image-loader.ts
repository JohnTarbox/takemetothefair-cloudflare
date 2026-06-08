/**
 * IMG1 (2026-06-07) — Next/Image custom loader.
 *
 * Wired in `next.config.mjs` via:
 *   images: { loader: "custom", loaderFile: "./src/lib/image-loader.ts" }
 *
 * Next/Image calls this loader once per srcSet width. For each call we
 * return a `cdn-cgi/image/...` URL at the requested width — Next then
 * emits a `<img srcSet="…1x, …2x, …">` that the browser picks from based
 * on viewport + DPR.
 *
 * Quality default 80 — matches the upload pipeline's `q85` master and
 * is a good visual baseline for WebP/AVIF derivatives. Callers can
 * override per-image via the `quality` prop on `<Image>`.
 *
 * `onerror=redirect` is set on every loader URL (2026-06-07 follow-up).
 * Verified via prod probe: a transform whose source 404s returns 404
 * without the param and 307→source with it. Costs nothing on the happy
 * path (CF doesn't even parse the param unless the transform itself
 * errors) and gives every Next/Image render a graceful fallback when
 * the source URL is reachable but the transform fails — including the
 * 5k/mo free-tier overflow case the spec calls out. The og:image
 * emissions in `generateMetadata` go around the loader (they call
 * `cdnImage()` directly with the fixed presets) so they do NOT get this
 * default; acceptable because og:image failures only break social
 * previews and the presets are deterministic.
 *
 * Edge-runtime safe: pure string composition, no I/O, no Node APIs.
 * Must be a default export per Next's loader contract.
 */

import { cdnImage } from "./cdn-image";

export default function imageLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}): string {
  return cdnImage(src, {
    width,
    format: "auto",
    quality: quality ?? 80,
    onerror: "redirect",
  });
}
