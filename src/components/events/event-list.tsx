import { EventCard } from "./event-card";
import type { events, venues, promoters } from "@/lib/db/schema";

type Event = typeof events.$inferSelect;
type Venue = typeof venues.$inferSelect;
type Promoter = typeof promoters.$inferSelect;

type VendorSummary = {
  id: string;
  businessName: string;
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
}

export function EventList({ events, emptyMessage = "No events found" }: EventListProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {events.map((event, index) => (
        // IMG-followup (2026-06-07) — exactly one preload per page
        // (index === 0); cards 1-2 still load eagerly. Matches the
        // single-priority rule in EventCard's prop docs.
        <EventCard key={event.id} event={event} priority={index === 0} eagerLoad={index < 3} />
      ))}
    </div>
  );
}
