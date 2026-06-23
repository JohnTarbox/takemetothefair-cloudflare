/**
 * C2 (2026-06-12) — homepage "ticket-stub" event card.
 *
 * The signature element of the homepage redesign (docs/c2-homepage-redesign-brief.md):
 * a perforated ticket with a category-coloured stub header + a big Fraunces date
 * numeral. Colour-coding reuses the existing 5-palette system in
 * src/lib/category-colors.ts (the `accent` fill + the new `onAccent` text colour),
 * so it stays in sync with badges/accent-bars elsewhere — and it elegantly handles
 * the ~81% of events with no photo (the card never needs an image).
 *
 * Homepage-only: the shared <EventCard> still serves /events. This card takes a
 * structural subset of the event shape so it composes with the existing
 * getWeekendEvents()/getFeaturedEvents() rows on the homepage.
 */
import Link from "next/link";
import { MapPin } from "lucide-react";
import { parseJsonArray } from "@/types";
import { getCategoryColors } from "@/lib/category-colors";
import { nextOccurrence, showsNextOccurrence } from "@/lib/event-occurrence";

export interface StubEvent {
  name: string;
  slug: string;
  startDate: Date | null;
  publicStartDate?: Date | null;
  // U-next (2026-06-21): occurrence inputs so the ticket-stub numeral shows the
  // NEXT upcoming date for recurring series (a weekly market) instead of the
  // season start. Already attached at every homepage fetch site via
  // attachEventDayDates; optional so other callers compile unchanged.
  endDate?: Date | null;
  discontinuousDates?: boolean | null;
  eventDayDates?: string[];
  categories: string | null; // JSON string array
  venue?: { city: string | null; state: string | null } | null;
}

// Dates are stored at noon UTC (project convention), so reading the UTC parts
// yields the intended calendar day in every US timezone.
function monthDay(d: Date): { mon: string; day: string } {
  return {
    mon: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
    day: String(d.getUTCDate()),
  };
}

export function StubEventCard({ event, compact = false }: { event: StubEvent; compact?: boolean }) {
  const categories = parseJsonArray(event.categories ?? "");
  const colors = getCategoryColors(categories);
  const primaryCategory = categories[0] ?? "Event";

  // U-next (2026-06-21): resolve the date the same way the detail page does —
  // the next upcoming occurrence for a recurring series, not the season start.
  const baseStart = event.publicStartDate ?? event.startDate;
  const occurrence = nextOccurrence({
    startDate: baseStart,
    endDate: event.endDate ?? null,
    discontinuousDates: event.discontinuousDates ?? null,
    eventDayDates: event.eventDayDates,
  });
  const date = occurrence?.date ?? baseStart;
  // A series already underway gets a "Next" eyebrow so the numeral reads clearly.
  const isNextOccurrence = showsNextOccurrence(occurrence);
  const md = date ? monthDay(date) : null;

  // "Ongoing through" treatment: a single contiguous multi-day event that is in
  // progress now AND keeps running past today (a festival straddling today and
  // the coming weekend). Showing a bare "Today / 23" under a "this week/weekend"
  // heading reads oddly, so we instead show the END date as the numeral with an
  // "Ongoing · thru" eyebrow. Gated on isContinuousMultiDay so weekly markets
  // (discrete occurrences) keep their "Next/Today" treatment.
  const end = event.endDate ?? null;
  const today = new Date();
  const endsAfterToday =
    !!end &&
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) >
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const isOngoingSpan =
    !!occurrence?.isOngoing && !!occurrence?.isContinuousMultiDay && endsAfterToday;
  const endMd = end ? monthDay(end) : null;

  const location = [event.venue?.city, event.venue?.state].filter(Boolean).join(", ");

  return (
    <Link
      href={`/events/${event.slug}`}
      className={`group flex flex-col overflow-hidden border-[1.5px] border-secondary bg-card transition-transform duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[7px_7px_0_rgb(var(--accent-terracotta)/0.22)] ${
        compact
          ? "rounded-[10px] shadow-[3px_3px_0_rgb(var(--secondary)/0.10)]"
          : "rounded-xl shadow-[4px_4px_0_rgb(var(--secondary)/0.10)]"
      }`}
    >
      {/* Stub header — category-coloured, with a perforated bottom edge (full size only). */}
      <div
        className={`relative ${colors.onAccent} ${compact ? "px-3 pb-2.5 pt-2.5" : "px-4 pb-4 pt-4"}`}
        style={{ background: colors.accent }}
      >
        {md ? (
          <>
            <div
              className={`font-bold uppercase tracking-[0.14em] opacity-90 ${compact ? "text-[10px]" : "text-xs"}`}
            >
              {isOngoingSpan && endMd
                ? `Ongoing · thru ${endMd.mon}`
                : occurrence?.isToday
                  ? "Today"
                  : isNextOccurrence
                    ? `Next · ${md.mon}`
                    : md.mon}
            </div>
            <div
              className={`font-display font-semibold leading-[0.95] ${compact ? "text-[26px]" : "text-[40px]"}`}
            >
              {isOngoingSpan && endMd ? endMd.day : md.day}
            </div>
          </>
        ) : (
          <div className="font-display text-2xl font-semibold leading-tight">Date TBA</div>
        )}
        {!compact && (
          <div
            className="absolute inset-x-0 -bottom-[7px] h-[14px]"
            style={{
              backgroundImage:
                "radial-gradient(circle at 7px 7px, rgb(var(--background)) 6px, transparent 6px)",
              backgroundSize: "16px 14px",
              backgroundRepeat: "repeat-x",
            }}
            aria-hidden="true"
          />
        )}
      </div>

      <div className={`flex flex-1 flex-col ${compact ? "p-3" : "p-4 pt-[18px]"}`}>
        {!compact && (
          <span
            className={`mb-2.5 self-start rounded border px-2 py-[3px] text-[11px] font-bold uppercase tracking-wide ${colors.badge}`}
          >
            {primaryCategory}
          </span>
        )}
        <h3
          className={`font-display font-semibold leading-[1.12] text-secondary ${compact ? "text-sm" : "text-[19px]"}`}
        >
          {event.name}
        </h3>
        {location && (
          <div
            className={`flex items-center gap-1.5 text-muted-foreground ${compact ? "pt-1.5 text-[11.5px]" : "mt-auto pt-3 text-[13.5px]"}`}
          >
            <MapPin className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            {location}
          </div>
        )}
      </div>
    </Link>
  );
}
