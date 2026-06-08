"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag-the-dot focal-point picker for cropping decisions.
 *
 * IMG1 §1b Phase 1 (2026-06-08) — UI half of the per-image focal-point
 * override feature. Pairs with the `image_focal_x` / `image_focal_y`
 * columns on events/venues/vendors/promoters and the `cdnImage` /
 * `focalPointGravity` helpers.
 *
 * Why a custom component instead of pulling in a focal-point library:
 *   - Trivial UX (one draggable dot on an image) — no library worth the
 *     bundle weight (the keystone-trim PR #333 dropped 6 MB to fit the
 *     CF Worker cap, so bundle hygiene is a project value)
 *   - Edge-runtime safe: pure DOM events, no Node APIs
 *   - The behavior is small enough that direct ownership beats vendor
 *     surface area to learn / debug
 *
 * Mirrors the Eventbrite admin UX: operator sees the FULL image
 * (`object-contain`, not cropped), drags a dot to mark the focal point,
 * and a 16:9 preview shows what the card thumbnail will look like at
 * that focal point. (Without the live preview, operators couldn't tell
 * whether they'd picked a useful point until they saved + viewed.)
 *
 * Coordinates are stored as (x, y) ∈ [0, 1] where (0, 0) is top-left
 * and (1, 1) is bottom-right — matches Cloudflare's `gravity=XxY`
 * coordinate system so the form value goes through to the CDN with
 * no transformation needed.
 *
 * Accessibility: the dot is keyboard-focusable + arrow-key-nudgeable
 * (1% per press, 5% with shift). Screen reader announces the current
 * coordinates via aria-valuetext. Falls back to two numeric inputs
 * (visible when JS-disabled or image fails to load) so the focal
 * point can always be edited, dot or no dot.
 */

export type FocalPointPickerProps = {
  /** Image URL to focal-point against. Should be the full source (not a CDN-cropped derivative). */
  src: string;
  /** Current x coordinate (0–1). */
  x: number;
  /** Current y coordinate (0–1). */
  y: number;
  /** Called with the new (x, y) on any change. Caller is responsible for persisting. */
  onChange: (x: number, y: number) => void;
  /** Aspect ratio of the crop preview window. Default 16/9 (matches card/hero). */
  previewAspect?: number;
  /** Maximum displayed picker width in px. Default 480 (fits in typical admin form). */
  maxWidth?: number;
  className?: string;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

export function FocalPointPicker({
  src,
  x,
  y,
  onChange,
  previewAspect = 16 / 9,
  maxWidth = 480,
  className,
}: FocalPointPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLButtonElement>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Drag handler — single path for mouse + touch + pen via PointerEvent.
  const handlePointer = useCallback(
    (e: PointerEvent | React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newX = clamp01((e.clientX - rect.left) / rect.width);
      const newY = clamp01((e.clientY - rect.top) / rect.height);
      onChange(newX, newY);
    },
    [onChange]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(true);
      // Snap to click location even if the user clicked away from the dot.
      handlePointer(e);
      // Capture so we keep getting move events even when the cursor leaves
      // the element (e.g. drag past the edge).
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [handlePointer]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      handlePointer(e);
    },
    [isDragging, handlePointer]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // releasePointerCapture throws if the id isn't currently captured —
      // benign (e.g., a stray pointerup with no preceding down).
    }
  }, []);

  // Keyboard support — arrow keys nudge 1% per press, shift+arrow 5%.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      let dx = 0;
      let dy = 0;
      switch (e.key) {
        case "ArrowLeft":
          dx = -step;
          break;
        case "ArrowRight":
          dx = step;
          break;
        case "ArrowUp":
          dy = -step;
          break;
        case "ArrowDown":
          dy = step;
          break;
        case "Home":
          onChange(0.5, 0.5);
          e.preventDefault();
          return;
        default:
          return;
      }
      e.preventDefault();
      onChange(clamp01(x + dx), clamp01(y + dy));
    },
    [x, y, onChange]
  );

  // Reset image-loaded state when src changes (e.g., operator changes the
  // image URL in the parent form).
  useEffect(() => {
    setImageLoaded(false);
    setImageError(false);
  }, [src]);

  const dotPercentX = Math.round(x * 100);
  const dotPercentY = Math.round(y * 100);

  return (
    <div className={className}>
      <div
        className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-start"
        style={{ maxWidth }}
      >
        {/* Main picker — full image with draggable dot overlay */}
        <div>
          <div
            ref={containerRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={`relative bg-muted rounded-lg overflow-hidden select-none ${
              isDragging ? "cursor-grabbing" : "cursor-crosshair"
            }`}
            style={{ touchAction: "none" }}
            role="application"
            aria-label="Focal point picker — drag the dot to set the focal point for image crops"
          >
            {/* The image. object-contain so the operator sees the whole thing. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              aria-hidden="true"
              decoding="async"
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageError(true)}
              className="block w-full h-auto"
              draggable={false}
            />

            {imageLoaded && !imageError && (
              <>
                {/* Crosshair guides through the dot center — helps operator
                    sight horizontal/vertical alignment to image features. */}
                <div
                  className="absolute inset-y-0 w-px bg-secondary-foreground/50 pointer-events-none"
                  style={{ left: `${dotPercentX}%` }}
                  aria-hidden="true"
                />
                <div
                  className="absolute inset-x-0 h-px bg-secondary-foreground/50 pointer-events-none"
                  style={{ top: `${dotPercentY}%` }}
                  aria-hidden="true"
                />
                {/* The draggable dot itself. */}
                <button
                  ref={dotRef}
                  type="button"
                  onKeyDown={handleKeyDown}
                  className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full bg-amber border-2 border-amber-bg-fg shadow-lg hover:scale-110 focus-visible:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-transform"
                  style={{ left: `${dotPercentX}%`, top: `${dotPercentY}%` }}
                  aria-label="Focal point"
                  aria-valuetext={`x ${dotPercentX} percent, y ${dotPercentY} percent`}
                  aria-roledescription="draggable focal-point marker"
                >
                  <span className="sr-only">
                    Focal point at {dotPercentX}% from left, {dotPercentY}% from top. Arrow keys
                    nudge by 1%, shift+arrow by 5%, Home resets to center.
                  </span>
                </button>
              </>
            )}

            {imageError && (
              <div className="aspect-video flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
                Image failed to load. You can still set the focal point using the inputs below.
              </div>
            )}

            {!imageLoaded && !imageError && (
              <div className="aspect-video flex items-center justify-center text-sm text-muted-foreground">
                Loading image…
              </div>
            )}
          </div>

          {/* Numeric fallback — always visible so keyboard-only operators
              and screen-reader users can edit precisely without dragging. */}
          <div className="mt-3 flex gap-2 text-sm">
            <label className="flex-1">
              <span className="block text-xs text-muted-foreground mb-1">Focal X (0–1)</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={x.toFixed(2)}
                onChange={(e) => onChange(clamp01(parseFloat(e.target.value)), y)}
                className="w-full px-2 py-1 rounded border border-input bg-card text-foreground"
              />
            </label>
            <label className="flex-1">
              <span className="block text-xs text-muted-foreground mb-1">Focal Y (0–1)</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={y.toFixed(2)}
                onChange={(e) => onChange(x, clamp01(parseFloat(e.target.value)))}
                className="w-full px-2 py-1 rounded border border-input bg-card text-foreground"
              />
            </label>
            <button
              type="button"
              onClick={() => onChange(0.5, 0.5)}
              className="self-end px-3 py-1 text-xs rounded border border-input bg-muted text-foreground hover:bg-border"
              title="Reset focal point to center (0.5, 0.5)"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Live crop preview. Shows what the card thumbnail looks like at
            the current focal point. Uses CSS object-position (cheap, no
            CDN call per drag-frame) — the actual saved value goes through
            CF's gravity at render time, but the geometry is identical. */}
        <div className="md:w-[200px]">
          <div className="text-xs font-medium text-muted-foreground mb-1">Card crop preview</div>
          <div
            className="bg-muted rounded overflow-hidden border border-border"
            style={{ aspectRatio: `${previewAspect}` }}
          >
            {imageLoaded && !imageError && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt=""
                aria-hidden="true"
                className="w-full h-full object-cover"
                style={{ objectPosition: `${dotPercentX}% ${dotPercentY}%` }}
                draggable={false}
              />
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1 leading-snug">
            What thumbnails will look like.
            <br />
            Detail-page hero is uncropped.
          </div>
        </div>
      </div>
    </div>
  );
}
