import { EventCard } from "./event-card";
import type { events, venues, promoters } from "@/lib/db/schema";

type Event = typeof events.$inferSelect;
type Venue = typeof venues.$inferSelect;
type Promoter = typeof promoters.$inferSelect;

type VendorSummary = {
  id: string;
  businessName: string;
  /** EH2.1 brand display override; null falls back to businessName. */
  displayName?: string | null;
  slug: string;
  logoUrl: string | null;
  vendorType: string | null;
};

interface EventListProps {
  events: (Event & {
    venue: Venue;
    promoter: Promoter;
    vendors?: VendorSummary[];
    // Cohort 7 follow-up (2026-06-01) — forwarded to EventCard so the
    // date badge resolves the next occurrence. Optional so existing
    // callers without the event_days JOIN still typecheck.
    eventDayDates?: string[];
  })[];
  emptyMessage?: string;
  /**
   * IMG backlog closeout (2026-06-08) — caller-controlled LCP priority.
   *
   * Pre-fix, EventList unconditionally set `priority={index === 0}` on
   * its first card. That defeats the "exactly one fetchpriority=high
   * per page" rule whenever a page renders multiple EventList grids
   * (e.g., the homepage with weekend / featured / upcoming = 3
   * priority cards on one page; the browser then deprioritizes all
   * three).
   *
   * Now defaults to false. Callers explicitly pass `firstCardPriority`
   * when this grid is the LCP candidate. On a page with multiple
   * grids, exactly one should opt in (typically the topmost one
   * with content; if uncertain, leave false — text H1 / non-image
   * elements can be LCP too).
   */
  firstCardPriority?: boolean;
}

export function EventList({
  events,
  emptyMessage = "No events found",
  firstCardPriority = false,
}: EventListProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {events.map((event, index) => (
        <EventCard key={event.id} event={event} priority={firstCardPriority && index === 0} />
      ))}
    </div>
  );
}
