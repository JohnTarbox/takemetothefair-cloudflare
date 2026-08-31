"use client";

import { useState } from "react";
import Image from "next/image";
import { X } from "lucide-react";
import { cdnImage, CARD_THUMB, HERO_DESKTOP } from "@/lib/cdn-image";

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
 *   thumbs via /cdn-cgi/image      cdnImage(url, CARD_THUMB) — 600×400
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
          <button
            key={img.id}
            type="button"
            onClick={() => setOpen(i)}
            className="relative aspect-[3/2] overflow-hidden rounded-lg border border-border hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-royal"
            aria-label={`Open photo: ${img.alt}`}
          >
            <Image
              src={cdnImage(img.url, { ...CARD_THUMB, rotate: img.rotation })}
              alt={img.alt}
              fill
              sizes="(max-width: 640px) 50vw, 300px"
              // Below the fold, always. The hero above keeps fetchpriority.
              loading="lazy"
              className="object-cover"
            />
          </button>
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
