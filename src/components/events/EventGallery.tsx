"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { cdnImage, cdnSrcSet, HERO_DESKTOP, THUMB_WIDTHS, thumbOpts } from "@/lib/cdn-image";

export interface EventGalleryImage {
  id: string;
  url: string;
  /** Guaranteed non-empty by `resolvePhotoAlt` — see event-photos.ts. */
  alt: string;
  caption?: string;
  /**
   * OPE-686 — render-time rotation, or undefined when upright.
   *
   * Stored rather than baked into the object, so it has to reach the URL
   * builder or the correction is inert: the photo stays sideways and the
   * rotate tool looks like it did nothing.
   */
  rotation?: 90 | 180 | 270;
}

/**
 * OPE-212 §3 — the public event gallery/collage.
 *
 * John's guardrails, and where each lives:
 *
 *   thumbs via /cdn-cgi/image      cdnSrcSet(url, THUMB_WIDTHS, thumbOpts) —
 *                                  3:2 fit=cover at 400/800/1200w (OPE-1080)
 *   lightbox at a larger variant   cdnImage(url, HERO_DESKTOP)
 *   lazy-loaded below the fold     loading="lazy" on every tile
 *   hero fetchpriority preserved   this component NEVER renders the hero, so
 *                                  it cannot compete for it
 *   alt never empty                resolved server-side before it gets here
 *
 * That fourth one is the subtle one. The hero is the LCP element with
 * `fetchpriority="high"`, and the surest way to protect that is for the
 * gallery to have no opinion about the hero at all — it renders only the
 * `event_photos` rows, and `events.image_url` stays the canonical hero.
 */
export function EventGallery({
  images,
  eventName,
}: {
  images: EventGalleryImage[];
  eventName: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (images.length === 0) return null;

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-3">Photos from {eventName}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {images.map((img, i) => (
          // OPE-1171 — caption visible in the grid, not only in the lightbox.
          <figure key={img.id} className="m-0">
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="relative aspect-[3/2] w-full overflow-hidden rounded-lg border border-border hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-royal"
              aria-label={`Open photo: ${img.alt}`}
            >
              {/* OPE-1080 — raw <img> with a hand-built ladder, NOT next/image.
                  next/image was handed an already-transformed width=600 URL;
                  the loader returns those unchanged, so all nine srcset
                  candidates (384w…3840w) were the same 600px render. Here each
                  candidate's width param IS its descriptor (cdnSrcSet enforces
                  it) and the crop stays server-side. Foreign hotlinks get no
                  srcset at all rather than a fake one. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cdnImage(img.url, thumbOpts(800, { rotate: img.rotation }))}
                srcSet={cdnSrcSet(img.url, THUMB_WIDTHS, (w) =>
                  thumbOpts(w, { rotate: img.rotation })
                )}
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 300px"
                alt={img.alt}
                width={800}
                height={533}
                // Below the fold, always. The hero above keeps fetchpriority.
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover"
              />
            </button>
            {img.caption && (
              <figcaption className="mt-1 text-sm text-muted-foreground line-clamp-2">
                {img.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>

      {open !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={images[open].alt}
          onClick={() => setOpen(null)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(null)}
          tabIndex={-1}
        >
          <button
            type="button"
            onClick={() => setOpen(null)}
            aria-label="Close photo"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <figure className="max-h-full max-w-4xl">
            {/* eslint-disable-next-line @next/next/no-img-element -- the
                lightbox needs intrinsic sizing on an already-transformed URL;
                next/image would re-wrap a CDN-sized image for no gain. */}
            <img
              src={cdnImage(images[open].url, { ...HERO_DESKTOP, rotate: images[open].rotation })}
              alt={images[open].alt}
              className="max-h-[80vh] w-auto rounded-lg"
            />
            {images[open].caption && (
              <figcaption className="mt-2 text-center text-sm text-white/90">
                {images[open].caption}
              </figcaption>
            )}
          </figure>
        </div>
      )}
    </div>
  );
}
