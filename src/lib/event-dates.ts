/**
 * Date helpers for the events table.
 *
 * `normalizeEventDate` is a re-export from @takemetothefair/utils so the
 * MCP Worker can wire through the same canonical noon-UTC normalizer
 * (A3, Dev backlog 2026-06-05). Existing main-app imports
 * (@/lib/event-dates) keep working unchanged.
 *
 * `upcomingEndPredicate` is the shared predicate for "is this event still
 * upcoming?" filters across listings, search, sitemap, and home modules
 * (A2, Dev backlog 2026-06-05). Pre-A2, each surface inlined
 * `gte(events.endDate, new Date())`, which dropped events from public
 * search the moment their stored end-date passed — for a noon-UTC
 * anchored event running 5pm–9pm EDT, that meant disappearing at 8am EDT
 * the same morning. Comparing against `now - 24h` gives every event a
 * full extra calendar day of visibility, which covers the
 * stored-anchor-precedes-actual-end-time gap without a per-row join.
 */
import { sql, gte, type SQL } from "drizzle-orm";
import { events, eventDays } from "@/lib/db/schema";

export { normalizeEventDate } from "@takemetothefair/utils";

/** Number of milliseconds in 24 hours. Public for tests. */
export const UPCOMING_END_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Drizzle predicate for "this event is still upcoming." Compares
 * `events.end_date` to `(now - 24h)` so an evening event whose stored
 * end-date sits at noon UTC the same calendar day doesn't fall out of
 * the upcoming filter at 8am EDT. Uses a 24h grace because the precise
 * close-time fix (joining event_days.close_time per row) is a deeper
 * change; the email's "give it one more day" rule is the minimal
 * conservative fix that matches operator intuition ("an event happening
 * today should be searchable today").
 *
 * For surfaces that need to include events with no end_date (e.g.
 * promoters/[slug] which falls back to the home-page rule), wrap in
 * `or(upcomingEndPredicate(now), isNull(events.endDate))`.
 */
export function upcomingEndPredicate(now: Date): SQL {
  const cutoff = new Date(now.getTime() - UPCOMING_END_GRACE_MS);
  return gte(events.endDate, cutoff);
}

/**
 * C2 P2 (2026-06-12) — upper bound on `events.start_date` for the homepage
 * "when" quick-filter chips routed to /events?when=…:
 *   week    → events from now through the end of the current week (coming Sun)
 *   weekend → same upper bound (now through the coming Sunday)
 *   month   → events starting within the next 30 days
 * Returns null for any other/absent value (no date cap). Shared by the
 * /events query and countPublicFilteredEvents so the two never drift.
 *
 * `week` and `weekend` share an identical horizon: the query is lower-bounded by
 * `endDate >= now` (upcomingEndPredicate), so both already span "now through the
 * coming Sunday." `week` is the honest label for that span (it includes mid-week
 * events in progress); `weekend` is kept for the existing homepage search chip.
 */
export function whenWindowEnd(when: string | undefined, from: Date = new Date()): Date | null {
  if (when === "month") {
    return new Date(from.getTime() + 30 * 86_400_000);
  }
  if (when === "week" || when === "weekend") {
    // Through the end of the current week — the coming Sunday — NOT a flat
    // "next 7 days" (which would pull in an event a full week out). If today is
    // Sunday, this covers just today; otherwise it runs to the coming Sunday.
    // UTC day boundaries: events store start_date at noon UTC, so capping at
    // 00:00 UTC of the Monday after Sunday includes every event through Sunday.
    const dow = from.getUTCDay(); // 0 = Sun … 6 = Sat
    const daysUntilSunday = (7 - dow) % 7;
    return new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + daysUntilSunday + 1)
    );
  }
  return null;
}

/**
 * Variant for tables joined under an alias (rare). Most callers use the
 * bare `upcomingEndPredicate(now)`. Kept here so any future SQL builder
 * that needs an inline literal can call this without re-deriving the
 * cutoff.
 */
export function upcomingEndPredicateRaw(now: Date): SQL {
  const cutoffSec = Math.floor((now.getTime() - UPCOMING_END_GRACE_MS) / 1000);
  return sql`${events.endDate} >= ${cutoffSec}`;
}

/** Format a Date as a UTC "YYYY-MM-DD" day string (matches `event_days.date`). */
export function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * OPE-48 — refinement predicate for the "Happening This Week" homepage module
 * and the `/events?when=week|weekend` filter (which its "See all" links to, so
 * the two MUST agree).
 *
 * An event qualifies only when it EITHER:
 *   (a) has a non-closed `event_days` row whose date is within the window
 *       [today, windowEnd) — i.e. a real occurrence happens this week; OR
 *   (b) has NO `event_days` rows at all — a simple single/multi-day event, left
 *       to the caller's existing start/end-date span filters unchanged.
 *
 * This EXCLUDES season-long recurring events (a wide start/end span PLUS a set
 * of scheduled `event_days`) whose next actual occurrence is beyond the window
 * — the bug where "Artisans' Market in Unity" (next day Jul 18) leaked into the
 * Jul 2–5 module because its Apr→Dec span trivially overlapped the week.
 *
 * `event_days.date` is TEXT "YYYY-MM-DD", so we compare against day strings:
 *   - `>= today` — a past occurrence earlier this week does NOT qualify, keeping
 *     the label consistent with the card's next-upcoming date.
 *   - `< windowEnd` — windowEnd is 00:00 UTC of the Monday after the coming
 *     Sunday (see `whenWindowEnd`), so "< Monday" means "through Sunday".
 *
 * Layered ON TOP of the caller's existing predicates (it never loosens them),
 * so events without `event_days` behave exactly as before — zero regression to
 * single-day events.
 */
export function hasOccurrenceInWindowOrUndated(now: Date, windowEnd: Date): SQL {
  const startStr = utcDateStr(now);
  const endStr = utcDateStr(windowEnd);
  return sql`(
    EXISTS (
      SELECT 1 FROM ${eventDays}
      WHERE ${eventDays.eventId} = ${events.id}
        AND ${eventDays.date} >= ${startStr}
        AND ${eventDays.date} < ${endStr}
        AND COALESCE(${eventDays.closed}, 0) = 0
    )
    OR NOT EXISTS (
      SELECT 1 FROM ${eventDays} WHERE ${eventDays.eventId} = ${events.id}
    )
  )`;
}
