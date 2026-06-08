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
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {events.map((event, index) => (
        // IMG-followup (2026-06-08) — exactly one preload per page
        // (index === 0). Cards 1-N use Next/Image default lazy;
        // eagerLoad prop reverted (Next.js 15.x emits preload for
        // loading="eager" too, which defeats the single-priority rule).
        <EventCard key={event.id} event={event} priority={index === 0} />
      ))}
    </div>
  );
}
