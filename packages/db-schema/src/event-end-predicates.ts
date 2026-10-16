/**
 * OPE-1375 — "is this event upcoming / past?", in one place both deploy
 * artifacts import (main app via `@/lib/event-dates`, MCP Worker directly).
 *
 * Event dates are anchored at NOON UTC. The inline `gte(events.endDate, now)`
 * that most surfaces used (A2, Dev backlog 2026-06-05) therefore dropped an
 * event from "upcoming" at 12:00Z — 08:00 Eastern — on its own last day, and
 * the mirror `lt(events.endDate, now)` listed it as "past" at the same instant.
 * Both also mishandled a NULL end_date (OPE-1035): `NULL >= x` and `NULL < x`
 * are NULL, so a start-date-only event was in neither list.
 *
 * The rule, shared by both predicates:
 *   - the event's effective end is `COALESCE(end_date, start_date)` — a NULL
 *     end means a single-day event ending on its start date;
 *   - it is upcoming while that end is >= `now - 24h`, and past once it is
 *     < `now - 24h`. The 24h grace covers the gap between the noon-UTC anchor
 *     and the event's real close time without a per-row event_days join.
 *
 * `pastEndPredicate` is the EXACT complement of `upcomingEndPredicate` on every
 * row that has a date: same expression, same cutoff, `<` vs `>=`. A row with
 * neither date matches neither (it has no day to place it on).
 *
 * Inline comparisons of `events.endDate` against "now" are banned outside this
 * file by `src/lib/__tests__/no-inline-end-date-predicates-ope1375.test.ts`.
 */
import { sql, type SQL } from "drizzle-orm";
import { events } from "./index";

/** Number of milliseconds in 24 hours. Public for tests. */
export const UPCOMING_END_GRACE_MS = 24 * 60 * 60 * 1000;

/** Epoch SECONDS (D1 date columns) of the upcoming/past boundary for `now`. */
export function upcomingEndCutoffSec(now: Date): number {
  return Math.floor((now.getTime() - UPCOMING_END_GRACE_MS) / 1000);
}

/** The event is still upcoming (or in progress) as of `now`. */
export function upcomingEndPredicate(now: Date): SQL {
  return sql`COALESCE(${events.endDate}, ${events.startDate}) >= ${upcomingEndCutoffSec(now)}`;
}

/** The event is over as of `now` — the exact complement of `upcomingEndPredicate`. */
export function pastEndPredicate(now: Date): SQL {
  return sql`COALESCE(${events.endDate}, ${events.startDate}) < ${upcomingEndCutoffSec(now)}`;
}
