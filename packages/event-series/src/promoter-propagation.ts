/**
 * OPE-1649 — keep a series' promoter in step with the event it was reassigned on.
 *
 * `event_series.promoter_id` is read by three things:
 *   - the series landing (`/events/<series-slug>`), whose JSON-LD `organizer`
 *     comes from it for the series AND every subEvent (get-series-landing.ts);
 *   - `create-occurrence(-core).ts`, which copies it into every NEW edition;
 *   - promoter succession (mcp-server/src/promoters/succession.ts).
 *
 * `update_event(promoter_id)` changed only `events.promoter_id`, so a series
 * minted while its event sat on the "Community Suggestions" placeholder kept
 * serving that placeholder as the organizer after the event got its real one,
 * and handed it to the next year's occurrence too. Measured 2026-11-16: 145 of
 * the series with live members disagreed with at least one member, 110 of them
 * sitting on the placeholder.
 *
 * The rule (one decision function, unit-tested on its own):
 *   1. the series already has the new promoter → nothing to do;
 *   2. the series has NO promoter, or the placeholder → take the new one;
 *   3. the series agreed with this event's OLD promoter AND this event is the
 *      series' latest edition → take the new one (an organizer change shows
 *      up on the current edition; it is what the landing and the next
 *      occurrence should carry);
 *   4. anything else → leave the series alone and SAY so. A correction to a
 *      past edition, or a series another promoter already owns, is a judgement
 *      for a person — `update_series(promoter_id)` exists for it.
 */
import { and, eq, isNull, max, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@takemetothefair/db-schema";
import { events, eventSeries } from "@takemetothefair/db-schema";

type Db = DrizzleD1Database<typeof schema>;

/** The placeholder promoter community-suggested events are filed under. */
export const COMMUNITY_PROMOTER_ID = "system-community-suggestions";

export function isPlaceholderPromoter(id: string | null | undefined): boolean {
  return id === COMMUNITY_PROMOTER_ID;
}

export type SeriesPromoterDecision =
  | { propagate: false; reason: "already_set" }
  | { propagate: true; reason: "series_unset" | "series_placeholder" | "latest_edition" }
  | { propagate: false; reason: "series_owned_by_other_promoter" | "not_latest_edition" };

export function decideSeriesPromoterPropagation(input: {
  seriesPromoterId: string | null;
  oldEventPromoterId: string | null;
  newEventPromoterId: string;
  isLatestEdition: boolean;
}): SeriesPromoterDecision {
  const { seriesPromoterId, oldEventPromoterId, newEventPromoterId, isLatestEdition } = input;
  if (seriesPromoterId === newEventPromoterId) return { propagate: false, reason: "already_set" };
  if (seriesPromoterId === null) return { propagate: true, reason: "series_unset" };
  if (isPlaceholderPromoter(seriesPromoterId))
    return { propagate: true, reason: "series_placeholder" };
  if (seriesPromoterId !== oldEventPromoterId)
    return { propagate: false, reason: "series_owned_by_other_promoter" };
  return isLatestEdition
    ? { propagate: true, reason: "latest_edition" }
    : { propagate: false, reason: "not_latest_edition" };
}

export interface SeriesPromoterPropagation {
  seriesId: string;
  outcome: "updated" | "unchanged" | "skipped";
  reason:
    | SeriesPromoterDecision["reason"]
    | "series_missing"
    | "series_changed_concurrently"
    | "propagation_failed";
  from: string | null;
  to: string | null;
}

/**
 * Apply the rule after an event's promoter changed. Call it AFTER the event
 * write has landed: the event is the operator's request, the series is the
 * follow-on. The UPDATE is conditional on the value just read, so a series
 * someone else changed in between is reported, not overwritten.
 */
export async function propagatePromoterToSeries(
  db: Db,
  args: {
    eventId: string;
    seriesId: string;
    eventStartDate: Date | null;
    oldPromoterId: string | null;
    newPromoterId: string;
    now?: Date;
  }
): Promise<SeriesPromoterPropagation> {
  const [series] = await db
    .select({ promoterId: eventSeries.promoterId })
    .from(eventSeries)
    .where(eq(eventSeries.id, args.seriesId))
    .limit(1);
  if (!series) {
    return {
      seriesId: args.seriesId,
      outcome: "skipped",
      reason: "series_missing",
      from: null,
      to: null,
    };
  }

  // Latest edition = no OTHER live member starts later. An undated event counts
  // as latest only when no other live member has a start date either.
  const [others] = await db
    .select({ latest: max(events.startDate) })
    .from(events)
    .where(
      and(
        eq(events.seriesId, args.seriesId),
        isNull(events.mergedInto),
        ne(events.id, args.eventId)
      )
    );
  const otherLatest = others?.latest ?? null;
  const isLatestEdition =
    otherLatest === null ||
    (args.eventStartDate !== null && args.eventStartDate.getTime() >= otherLatest.getTime());

  const decision = decideSeriesPromoterPropagation({
    seriesPromoterId: series.promoterId ?? null,
    oldEventPromoterId: args.oldPromoterId,
    newEventPromoterId: args.newPromoterId,
    isLatestEdition,
  });
  const from = series.promoterId ?? null;
  if (!decision.propagate) {
    return {
      seriesId: args.seriesId,
      outcome: decision.reason === "already_set" ? "unchanged" : "skipped",
      reason: decision.reason,
      from,
      to: from,
    };
  }

  const res = await db
    .update(eventSeries)
    .set({ promoterId: args.newPromoterId, updatedAt: args.now ?? new Date() })
    .where(
      and(
        eq(eventSeries.id, args.seriesId),
        from === null ? isNull(eventSeries.promoterId) : eq(eventSeries.promoterId, from)
      )
    )
    .returning({ id: eventSeries.id });
  if (res.length === 0) {
    return {
      seriesId: args.seriesId,
      outcome: "skipped",
      reason: "series_changed_concurrently",
      from,
      to: from,
    };
  }
  return {
    seriesId: args.seriesId,
    outcome: "updated",
    reason: decision.reason,
    from,
    to: args.newPromoterId,
  };
}
