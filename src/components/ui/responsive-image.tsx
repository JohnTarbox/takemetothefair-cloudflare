import NextImage, { type ImageProps } from "next/image";
import { cdnVariesByWidth } from "@/lib/cdn-image";

/**
 * OPE-1080 — next/image, but never with a fake srcset.
 *
 * The custom loader (`src/lib/image-loader.ts`) can only resize sources that
 * `cdn-cgi/image` can reach. For anything else — a hotlinked third-party
 * image, an already-transformed `/cdn-cgi/image/` URL, a relative path, a
 * `blob:` preview — it returns the URL unchanged, and next/image then emits a
 * srcset of up to 9 descriptors (384w…3840w) that all point at the same bytes.
 *
 * For those sources this sets `unoptimized`, which makes next/image emit a
 * single honest `src` with no srcset/sizes. Resizable sources are untouched.
 *
 * Every render-time `<Image>` in the app imports this instead of next/image;
 * `src/components/events/__tests__/EventGallery-srcset-ope1080.test.tsx` fails on a direct import.
 */
function srcString(src: ImageProps["src"]): string {
  if (typeof src === "string") return src;
  // Static import: `{ src }` or `{ default: { src } }`.
  if ("default" in src) return src.default.src;
  return src.src;
}

export default function Image(props: ImageProps) {
  const unoptimized = props.unoptimized ?? !cdnVariesByWidth(srcString(props.src));
  return <NextImage {...props} unoptimized={unoptimized} />;
}
