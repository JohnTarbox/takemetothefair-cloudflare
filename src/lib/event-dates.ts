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
import { events } from "@/lib/db/schema";

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
 *   weekend → events starting within the next 7 days
 *   month   → events starting within the next 30 days
 * Returns null for any other/absent value (no date cap). Shared by the
 * /events query and countPublicFilteredEvents so the two never drift.
 */
export function whenWindowEnd(when: string | undefined, from: Date = new Date()): Date | null {
  const days = when === "weekend" ? 7 : when === "month" ? 30 : null;
  return days == null ? null : new Date(from.getTime() + days * 86_400_000);
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
