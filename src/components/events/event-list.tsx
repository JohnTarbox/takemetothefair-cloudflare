import { EventCard } from "./event-card";
import type { Event, Venue, Promoter } from "@prisma/client";

interface EventListProps {
  events: (Event & {
    venue: Venue;
    promoter: Promoter;
  })[];
  emptyMessage?: string;
}

export function EventList({
  events,
  emptyMessage = "No events found",
}: EventListProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {events.map((event) => (
        <EventCard key={event.id} event={event} />
      ))}
    </div>
  );
}
