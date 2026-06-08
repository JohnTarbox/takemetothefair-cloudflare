/**
 * Print-only static map of the venue location.
 *
 * Per MMATF-UIUX-PrintSheet-Spec ("Map is the visual anchor, not a
 * photo: ~90% of events have coordinates vs ~19% with images; a
 * static map (from IMG1/coords) anchors the sheet").
 *
 * Renders via the same-zone `/api/static-map` proxy (NOT a direct
 * Google Static Maps URL) so the `GOOGLE_MAPS_API_KEY` stays
 * server-side — see that route's docblock for the rationale.
 *
 * Visibility:
 *   - `hidden print:block` — invisible on the on-screen event page,
 *     visible only when the user prints. The map is for the printed
 *     paper anchor; on screen, the Google Map link / venue card
 *     already serves the "where" question interactively.
 *
 * Failure mode:
 *   - If `/api/static-map` returns non-OK (missing key, upstream
 *     error), the `<img>` simply renders empty + alt text. The
 *     surrounding print sheet still has the venue address as text
 *     + the QR code for live directions, so the sheet remains
 *     useful.
 */
export function PrintEventMap({
  latitude,
  longitude,
  venueName,
  /** Px width — sized for print at ~600px (≈ 2x at 300dpi). */
  width = 600,
  /** Px height — 2:1 letterbox is wide enough to show context
   *  without taking the full sheet height. */
  height = 300,
}: {
  latitude: number;
  longitude: number;
  venueName: string;
  width?: number;
  height?: number;
}) {
  const src = `/api/static-map?lat=${latitude}&lng=${longitude}&w=${width}&h=${height}&zoom=15`;
  return (
    <div className="hidden print:block mt-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`Map showing the location of ${venueName}`}
        width={width}
        height={height}
        className="w-full max-w-[600px] h-auto rounded border border-black/20"
        loading="eager"
        decoding="async"
      />
    </div>
  );
}
