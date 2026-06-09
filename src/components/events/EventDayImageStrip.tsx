import type { EventDay } from "@/types";
import { cdnImage, focalPointGravity } from "@/lib/cdn-image";
import { formatDateOnly, parseDateOnly } from "@/lib/datetime";

interface EventDayImageStripProps {
  days: EventDay[];
  className?: string;
}

// Visual constants — each chip is ~160×120 (4:3). Small enough to fit ~6
// in a row on desktop and scroll horizontally on mobile. 2x DPR is the
// realistic upper bound for retina; further widths waste transformation
// quota (CF Image billable per unique (src, opts) pair).
const CHIP_WIDTH = 160;
const CHIP_HEIGHT = 120;

/**
 * F2 / E.2a (Dev-Email-2026-06-09 §E.2, 2026-06-09) — per-occurrence
 * art for events with day-specific images. PR #412 added the
 * `event_days.image_url` + focal-point schema; this is the first
 * public consumer.
 *
 * Visibility rule: render ONLY when at least one day has a non-null
 * `imageUrl`. We deliberately do NOT fall back to the series-level
 * image when a per-day image is missing — that would be visual noise
 * since the series hero already renders prominently above the
 * schedule. The strip's job is to highlight "this day is visually
 * different," not "here are 5 copies of the same poster."
 *
 * Pattern reuse: focal-point handling mirrors the 4 existing card
 * sites (vendor-card.tsx:69, event-card.tsx:156, venue-card.tsx:84,
 * blog-post-card.tsx:75) — same `focalPointGravity(x, y)` helper,
 * same `cdnImage(...)` builder, same 1x/2x srcSet shape.
 */
export function EventDayImageStrip({ days, className }: EventDayImageStripProps) {
  const daysWithImages = days.filter((d) => d.imageUrl);
  if (daysWithImages.length === 0) return null;

  return (
    <div className={className}>
      <h3 className="text-sm font-semibold text-foreground mb-2">By day</h3>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {daysWithImages.map((day) => {
          const gravity = focalPointGravity(day.imageFocalX, day.imageFocalY);
          // 1x + 2x DPR. Cloudflare bills per unique (src, opts) pair;
          // the (0.5, 0.5) short-circuit in `focalPointGravity` means
          // operator-default focal points share the cache key with the
          // pre-IMG1 derivatives (zero re-billing on rollout).
          const src = cdnImage(day.imageUrl!, {
            width: CHIP_WIDTH,
            height: CHIP_HEIGHT,
            fit: "cover",
            ...(gravity ? { gravity } : {}),
            format: "auto",
            quality: 80,
            onerror: "redirect",
          });
          const srcSet = [CHIP_WIDTH, CHIP_WIDTH * 2]
            .map(
              (w) =>
                `${cdnImage(day.imageUrl!, {
                  width: w,
                  height: Math.round((w * CHIP_HEIGHT) / CHIP_WIDTH),
                  fit: "cover",
                  ...(gravity ? { gravity } : {}),
                  format: "auto",
                  quality: 80,
                  onerror: "redirect",
                })} ${w}w`
            )
            .join(", ");

          // Caption: short date + optional notes. parseDateOnly handles
          // the "YYYY-MM-DD" → Date conversion the rest of the codebase
          // standardized on (P3 / 2026-06-01 dateutil cleanup).
          const parsedDate = parseDateOnly(day.date);
          const dateLabel = parsedDate ? formatDateOnly(parsedDate) : day.date;

          return (
            <figure
              key={day.id ?? day.date}
              className="flex-shrink-0 w-40"
              style={{ width: `${CHIP_WIDTH}px` }}
            >
              <div
                className="overflow-hidden rounded-md bg-muted"
                style={{ aspectRatio: `${CHIP_WIDTH} / ${CHIP_HEIGHT}` }}
              >
                {/* Raw <img> so the manual srcSet + per-width gravity can
                    be expressed (next/image's loader signature can't pass
                    `fit`/`gravity`). Same trade-off as event-card.tsx. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  srcSet={srcSet}
                  sizes={`${CHIP_WIDTH}px`}
                  alt={`Image for ${dateLabel}`}
                  width={CHIP_WIDTH}
                  height={CHIP_HEIGHT}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover"
                />
              </div>
              <figcaption className="mt-1 text-xs text-muted-foreground truncate">
                <span className="font-medium text-foreground">{dateLabel}</span>
                {day.notes ? <span className="ml-1">— {day.notes}</span> : null}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
