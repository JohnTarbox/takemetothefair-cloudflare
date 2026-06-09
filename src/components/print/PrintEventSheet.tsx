import { PrintEventMap } from "./PrintEventMap";
import { PrintEventSheetFooter } from "./PrintEventSheetFooter";
import { displayDate } from "@/lib/event-occurrence";
import { displayVenueName } from "@/lib/venue-display";

/**
 * PRINT1 (Dev-Email-2026-06-08 §B, 2026-06-08) — purpose-built print
 * sheet for the event detail page.
 *
 * Yesterday's PR #400 shipped a v1 (`<PrintButton>`, `<PrintQR>`,
 * `<PrintEventSheetFooter>`, `<PrintEventMap>`, `@page` portrait
 * default + landscape opt-in for calendar). That v1 *printed the
 * screen view* — every screen control (favorite, share, admin edit,
 * view count) and every screen aesthetic (hero blur-bar backdrop, 3
 * lines of category-banner CTA) bled through to paper.
 *
 * Per spec §B1 ("easier to define a print-only template that opts IN
 * to needed elements than to opt-OUT of screen chrome"): this is the
 * opt-IN template. Screen-visible content is hidden on print by the
 * `.screen-only { display: none !important }` rule in globals.css; this
 * component is `hidden print:block` so it materializes only on paper.
 *
 * Layout:
 *   1. Header — event name + next-occurrence date (the load-bearing
 *      v1 gap: was emitting `event.startDate` for recurring series).
 *   2. Venue card — name + full address + map (depends on Maps Static
 *      API toggle currently pending in GCP per §G; graceful 404 fallback
 *      in `<PrintEventMap>`).
 *   3. Schedule — per-day hours from `event_days`, DQ4-aware (uses the
 *      same `formatRange` shape `DailyScheduleDisplay` introduced;
 *      duplicated here so the print sheet is self-contained).
 *   4. Description — truncated to ~400 chars + ellipsis, `break-inside:
 *      avoid` so it paginates cleanly when long.
 *   5. Footer — existing `<PrintEventSheetFooter>` (QR + canonical URL
 *      + freshness stamp).
 *
 * Style:
 *   - 11pt body, 18pt title — fits the spec's one-page constraint
 *     for a single-date short-description event.
 *   - `break-inside: avoid` on the venue card, schedule, and
 *     description so paginated overflow doesn't orphan partial blocks.
 */

interface PrintEventDay {
  id?: string;
  date: string;
  openTime: string | null;
  closeTime: string | null;
  closed?: boolean | null;
  vendorOnly?: boolean | null;
}

interface PrintEventSheetProps {
  event: {
    name: string;
    slug: string;
    description: string | null;
    startDate: Date | null;
    endDate: Date | null;
    discontinuousDates?: boolean | null;
    eventDays?: PrintEventDay[];
  };
  venue?: {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  promoter?: { name: string } | null;
  /** Optional override; defaults to the production canonical URL. */
  canonicalUrl?: string;
}

const DESCRIPTION_PRINT_MAX_CHARS = 400;

/** Print-friendly time formatter. Returns null when input is null/undefined.
 *  Mirrors `formatTime` from DailyScheduleDisplay — duplicated rather than
 *  re-exported so the print sheet has no runtime dependency on a Client
 *  Component module ("use client") that would otherwise pollute the
 *  print sheet's bundle. */
function formatTime12(time24: string | null | undefined): string | null {
  if (!time24) return null;
  const [hours, minutes] = time24.split(":").map(Number);
  const period = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 || 12;
  return minutes === 0
    ? `${hour12}${period}`
    : `${hour12}:${minutes.toString().padStart(2, "0")}${period}`;
}

const HOURS_UNKNOWN_COPY = "Hours not yet confirmed";

function formatRange(open: string | null | undefined, close: string | null | undefined): string {
  const o = formatTime12(open);
  const c = formatTime12(close);
  if (o && c) return `${o} – ${c}`;
  if (o) return o;
  if (c) return c;
  return HOURS_UNKNOWN_COPY;
}

function formatPrintDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatShortDate(dateStr: string): string {
  // event_days.date is "YYYY-MM-DD" wall-clock. Parse as UTC midnight to
  // sidestep TZ drift in display.
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function PrintEventSheet({ event, venue, promoter, canonicalUrl }: PrintEventSheetProps) {
  // Header date — displayDate honors event_days for recurring series
  // (the v1 bug was using event.startDate, which is the series START not
  // the next actual day to attend). Falls back to startDate when there's
  // no upcoming occurrence — better than nothing on a printed sheet.
  const occurrence = displayDate({
    startDate: event.startDate,
    endDate: event.endDate,
    eventDayDates: event.eventDays?.map((d) => d.date),
    discontinuousDates: event.discontinuousDates ?? null,
  });
  const headerDate = occurrence ? formatPrintDate(occurrence) : null;

  const url = canonicalUrl ?? `https://meetmeatthefair.com/events/${event.slug}`;

  // Description: short events get the full string; long ones get
  // ellipsized at ~400 chars to fit one page. Caller can pass anything
  // up to whatever the DB stores — no upstream truncation expected.
  let description = event.description ?? "";
  if (description.length > DESCRIPTION_PRINT_MAX_CHARS) {
    description = description.slice(0, DESCRIPTION_PRINT_MAX_CHARS).trimEnd() + "…";
  }

  // Schedule: collapse to "Daily HH:MM – HH:MM" when uniform, otherwise
  // render per-day. Skip vendor-only / closed days from the public list.
  const publicDays =
    event.eventDays
      ?.filter((d) => !d.closed && !d.vendorOnly)
      .sort((a, b) => a.date.localeCompare(b.date)) ?? [];
  const uniformHours =
    publicDays.length > 1 &&
    publicDays.every(
      (d) => d.openTime === publicDays[0].openTime && d.closeTime === publicDays[0].closeTime
    );

  const venueDisplayName = venue ? displayVenueName(venue) : null;
  const venueAddressLine =
    venue && (venue.address || venue.city || venue.state)
      ? [venue.address, venue.city, venue.state, venue.zip].filter(Boolean).join(", ")
      : null;
  const hasCoords = !!(venue?.latitude && venue?.longitude);

  return (
    <div
      // .print-sheet is the print stylesheet's opt-in display:block target;
      // hidden on screen via Tailwind's `hidden`.
      className="print-sheet hidden print:block text-black"
      style={{
        // 11pt body / 18pt h1 calibrated for letter-size portrait with the
        // 1.5cm @page margins (≈ 73% of an 8.5"×11" page).
        fontSize: "11pt",
        lineHeight: 1.35,
      }}
    >
      {/* Header — event name + next-occurrence date + promoter */}
      <header className="border-b-2 border-black/80 pb-3 mb-4" style={{ breakAfter: "avoid" }}>
        <h1 className="font-bold" style={{ fontSize: "20pt", marginBottom: "0.1in" }}>
          {event.name}
        </h1>
        {headerDate && (
          <p className="font-semibold" style={{ fontSize: "13pt" }}>
            {headerDate}
            {occurrence &&
              event.endDate &&
              event.startDate &&
              event.endDate.getTime() !== event.startDate.getTime() &&
              !publicDays.length && (
                <span className="font-normal"> through {formatPrintDate(event.endDate)}</span>
              )}
          </p>
        )}
        {promoter?.name && (
          <p className="mt-1" style={{ fontSize: "10pt" }}>
            Hosted by {promoter.name}
          </p>
        )}
      </header>

      {/* Venue card — name + address + map */}
      {venue && (
        <section
          className="mb-4 border border-black/30 rounded p-3"
          style={{ breakInside: "avoid" }}
        >
          {venueDisplayName && (
            <p className="font-semibold" style={{ fontSize: "12pt" }}>
              {venueDisplayName}
            </p>
          )}
          {venueAddressLine && (
            <p className="mt-1" style={{ fontSize: "10.5pt" }}>
              {venueAddressLine}
            </p>
          )}
          {hasCoords && (
            <PrintEventMap
              latitude={venue.latitude!}
              longitude={venue.longitude!}
              venueName={venueDisplayName || venue.name}
            />
          )}
        </section>
      )}

      {/* Schedule */}
      {publicDays.length > 0 && (
        <section className="mb-4" style={{ breakInside: "avoid" }}>
          <h2 className="font-semibold mb-1" style={{ fontSize: "12pt" }}>
            Schedule
          </h2>
          {uniformHours ? (
            <p style={{ fontSize: "11pt" }}>
              Daily: {formatRange(publicDays[0].openTime, publicDays[0].closeTime)}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {publicDays.map((d) => (
                <li key={d.id ?? d.date} className="flex gap-3" style={{ fontSize: "10.5pt" }}>
                  <span className="font-medium w-24 shrink-0">{formatShortDate(d.date)}</span>
                  <span>{formatRange(d.openTime, d.closeTime)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Description — short, ellipsized when long */}
      {description && (
        <section className="mb-4" style={{ breakInside: "avoid" }}>
          <h2 className="font-semibold mb-1" style={{ fontSize: "12pt" }}>
            About
          </h2>
          <p style={{ fontSize: "10.5pt" }}>{description}</p>
        </section>
      )}

      {/* Footer — QR + canonical URL + freshness stamp (existing v1 component) */}
      <PrintEventSheetFooter canonicalUrl={url} contextLabel="Live details & directions" />
    </div>
  );
}
