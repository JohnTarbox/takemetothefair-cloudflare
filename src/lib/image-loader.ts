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
  });
}
