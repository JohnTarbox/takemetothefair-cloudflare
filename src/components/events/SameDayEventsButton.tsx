"use client";

import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EventCard } from "@/components/events/event-card";
import type { events, venues, promoters } from "@/lib/db/schema";

type EventRow = typeof events.$inferSelect;
type VenueRow = typeof venues.$inferSelect;
type PromoterRow = typeof promoters.$inferSelect;

// Shape returned by GET /api/events/[slug]/same-day. Mirrors the joined
// row shape EventCard expects (event + venue + promoter, vendors omitted
// to keep the response cheap — same-day cards de-emphasize the lineup).
type SameDayEvent = EventRow & {
  venue: VenueRow | null;
  promoter: PromoterRow | null;
};

interface Props {
  slug: string;
  startDate: Date | string | null;
  endDate: Date | string | null;
}

/**
 * "Other events on these dates" widget. Renders nothing until the user
 * clicks to expand — on click, fetches a JSON list of overlapping
 * publicly-visible events from /api/events/[slug]/same-day and renders
 * them as EventCards. Empty state when zero matches; error state on
 * non-2xx; "Hide" toggle returns to the initial collapsed state.
 *
 * Returns null when both startDate and endDate are missing (TBD/undated
 * events have no anchor to overlap with). Aligns with the project's
 * existing lazy-fetch pattern (see VendorApplyButton).
 */
export function SameDayEventsButton({ slug, startDate, endDate }: Props) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "loaded"; events: SameDayEvent[] }
    | { kind: "error" }
  >({ kind: "idle" });

  if (!startDate && !endDate) return null;

  const handleClick = async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/same-day`);
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await res.json()) as { success: boolean; events?: SameDayEvent[] };
      if (!body.success || !Array.isArray(body.events)) {
        setState({ kind: "error" });
        return;
      }
      setState({ kind: "loaded", events: body.events });
    } catch {
      setState({ kind: "error" });
    }
  };

  return (
    <section className="mt-8" aria-labelledby="same-day-heading">
      <h2 id="same-day-heading" className="text-xl font-semibold text-foreground">
        Curious what else is happening?
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Other public events whose dates overlap with this one.
      </p>

      {state.kind === "idle" && (
        <div className="mt-3">
          <Button type="button" variant="outline" onClick={handleClick}>
            <CalendarRange className="w-4 h-4 mr-2" aria-hidden />
            See other events on these dates
          </Button>
        </div>
      )}

      {state.kind === "loading" && (
        <div
          className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          aria-live="polite"
          aria-busy="true"
          data-testid="same-day-loading"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-72 rounded-lg bg-muted animate-pulse" aria-hidden />
          ))}
        </div>
      )}

      {state.kind === "loaded" && state.events.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="same-day-empty">
          No other public events found whose dates overlap with this one.
        </p>
      )}

      {state.kind === "loaded" && state.events.length > 0 && (
        <>
          <div
            className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
            data-testid="same-day-results"
          >
            {state.events.map((ev) => (
              <EventCard key={ev.id} event={ev} />
            ))}
          </div>
          <div className="mt-3">
            <Button type="button" variant="ghost" onClick={() => setState({ kind: "idle" })}>
              Hide
            </Button>
          </div>
        </>
      )}

      {state.kind === "error" && (
        <div className="mt-4" role="alert">
          <p className="text-sm text-red-700" data-testid="same-day-error">
            Couldn&rsquo;t load competing events. Please retry.
          </p>
          <Button type="button" variant="outline" onClick={handleClick} className="mt-2">
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
