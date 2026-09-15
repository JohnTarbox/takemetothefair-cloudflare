/**
 * OPE-1028 — "is this event in state X?", in one place both deploy artifacts
 * import.
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 *
 * `events.state_code` is documented as "denormalized from venue.state", but
 * nothing enforces the denormalization: every writer has to remember to copy
 * it. On 2026-09-15, 54 of 744 upcoming public events had `state_code` NULL
 * while their venue carried a state — written by six different ingestion
 * paths between 2026-05-29 and 08-30, so no single writer was "the" bug.
 *
 * The public LIST pages filtered on `events.state_code = ?` and dropped all 54.
 * The MCP reader (`search_events`) already used the venue's state (OPE-607), so
 * the two surfaces disagreed: `/events/maine/this-weekend` omitted
 * fall-festival-oquossoc-2026, brunswick-american-legion-craft-fair and
 * york-art-in-the-park-2026 while the reader returned all three. It was not
 * caching — the predicate could not return those rows at any cache age.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * Where a venue is linked, ITS state is authoritative. `state_code` answers
 * only for a venue-less event, which is the case the column exists for. That is
 * exactly OPE-607's reader semantics, so list and reader now agree because they
 * run the same SQL, not because two copies happen to match.
 *
 * A correlated EXISTS rather than a join condition, so the predicate is correct
 * whether or not the caller's query joins `venues` — several state queries do
 * not, and a join-dependent predicate would silently match nothing there.
 *
 * Guard: `src/lib/__tests__/event-state-predicate.test.ts` fails if any source
 * file filters on `eq(events.stateCode, …)` again.
 */
import { sql, type SQL } from "drizzle-orm";
import { events } from "./index";

export function eventInStateWhere(state: string): SQL {
  return sql`(CASE WHEN ${events.venueId} IS NULL
    THEN upper(${events.stateCode}) = upper(${state})
    ELSE EXISTS (
      SELECT 1 FROM venues AS state_venue
      WHERE state_venue.id = ${events.venueId}
        AND upper(state_venue.state) = upper(${state})
    )
  END)`;
}
