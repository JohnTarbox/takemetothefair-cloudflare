"use client";

import { useState } from "react";
import Image from "next/image";
import { X } from "lucide-react";

export interface GalleryImage {
  url: string;
  alt: string;
  caption?: string;
}

interface Props {
  images: GalleryImage[];
  vendorName: string;
}

/**
 * Two-image gallery with a simple lightbox. Phase 1 keeps it minimal —
 * no carousels, no zoom. Click opens a fullscreen overlay; click anywhere
 * or press Escape to close.
 */
export function VendorGallery({ images, vendorName }: Props) {
  const [open, setOpen] = useState<number | null>(null);

  if (images.length === 0) return null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {images.slice(0, 2).map((img, i) => (
          <button
            key={img.url}
            type="button"
            onClick={() => setOpen(i)}
            className="aspect-square relative overflow-hidden rounded-lg border border-gray-200 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-royal"
            aria-label={`Open ${img.alt || "image"} from ${vendorName} gallery`}
          >
            <Image
              src={img.url}
              alt={img.alt}
              fill
              sizes="(max-width: 768px) 50vw, 300px"
              className="object-cover"
            />
          </button>
        ))}
      </div>

      {open !== null && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setOpen(null)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(null)}
        >
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="absolute top-4 right-4 text-white p-2"
            aria-label="Close"
          >
            <X className="w-6 h-6" />
          </button>
          <div className="relative max-w-4xl max-h-full w-full h-full flex flex-col items-center justify-center">
            <div className="relative w-full max-h-[80vh] aspect-[4/3]">
              <Image
                src={images[open].url}
                alt={images[open].alt}
                fill
                sizes="100vw"
                className="object-contain"
              />
            </div>
            {images[open].caption && (
              <p className="text-white text-sm mt-3 text-center">{images[open].caption}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
