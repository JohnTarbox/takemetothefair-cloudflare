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

export interface StubEvent {
  name: string;
  slug: string;
  startDate: Date | null;
  publicStartDate?: Date | null;
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

export function StubEventCard({ event }: { event: StubEvent }) {
  const categories = parseJsonArray(event.categories ?? "");
  const colors = getCategoryColors(categories);
  const primaryCategory = categories[0] ?? "Event";
  const date = event.publicStartDate ?? event.startDate;
  const md = date ? monthDay(date) : null;

  const location = [event.venue?.city, event.venue?.state].filter(Boolean).join(", ");

  return (
    <Link
      href={`/events/${event.slug}`}
      className="group flex flex-col overflow-hidden rounded-xl border-[1.5px] border-secondary bg-card shadow-[4px_4px_0_rgb(var(--secondary)/0.10)] transition-transform duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[7px_7px_0_rgb(var(--accent-terracotta)/0.22)]"
    >
      {/* Stub header — category-coloured, with a perforated bottom edge. */}
      <div
        className={`relative px-4 pb-4 pt-4 ${colors.onAccent}`}
        style={{ background: colors.accent }}
      >
        {md ? (
          <>
            <div className="text-xs font-bold uppercase tracking-[0.14em] opacity-90">{md.mon}</div>
            <div className="font-display text-[40px] font-semibold leading-[0.95]">{md.day}</div>
          </>
        ) : (
          <div className="font-display text-2xl font-semibold leading-tight">Date TBA</div>
        )}
        {/* perforation: a row of background-coloured notches straddling the seam */}
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
      </div>

      <div className="flex flex-1 flex-col p-4 pt-[18px]">
        <span
          className={`mb-2.5 self-start rounded border px-2 py-[3px] text-[11px] font-bold uppercase tracking-wide ${colors.badge}`}
        >
          {primaryCategory}
        </span>
        <h3 className="font-display text-[19px] font-semibold leading-[1.12] text-secondary">
          {event.name}
        </h3>
        {location && (
          <div className="mt-auto flex items-center gap-1.5 pt-3 text-[13.5px] text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            {location}
          </div>
        )}
      </div>
    </Link>
  );
}
