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
 * OPE-686 — the `#rot=<deg>` convention.
 *
 * A gallery photo's rotation is stored in D1 and applied at render, not baked
 * into the object. Next/Image's loader contract passes only `{src, width,
 * quality}`, so there is nowhere to hand it a fourth argument — and building
 * the transform URL in the component instead would collapse the responsive
 * srcSet, because `cdnImage` returns an already-transformed URL unchanged and
 * every width would then point at the same derivative.
 *
 * So the caller appends a URL FRAGMENT: `photo.webp#rot=90`. Fragments are
 * never sent to a server, so a raw `<img src>` carrying one still resolves to
 * the same object; this loader strips it and turns it into `rotate=90`. The
 * photo stays responsive and comes out the right way up.
 *
 * Edge-runtime safe: pure string composition, no I/O, no Node APIs.
 * Must be a default export per Next's loader contract.
 */

import { cdnImage } from "./cdn-image";
import { rotationCdnOption } from "@takemetothefair/db-schema";

/** Split `…/photo.webp#rot=90` into its source and its rotation. */
export function parseRotationFragment(src: string): {
  src: string;
  rotate: 90 | 180 | 270 | undefined;
} {
  const hash = src.indexOf("#rot=");
  if (hash === -1) return { src, rotate: undefined };
  const deg = Number(src.slice(hash + 5));
  return { src: src.slice(0, hash), rotate: rotationCdnOption(deg) };
}

export default function imageLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}): string {
  const { src: bare, rotate } = parseRotationFragment(src);
  return cdnImage(bare, {
    width,
    format: "auto",
    quality: quality ?? 80,
    onerror: "redirect",
    ...(rotate ? { rotate } : {}),
  });
}
