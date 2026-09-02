/**
 * OPE-759 — the rule for whether an event's HOURS need review.
 *
 * Shared because the decision must be identical wherever `event_days` is
 * written, and `event_days` has five writers. Follows this package's existing
 * convention (`containsCI`, `rosterResearchTargetWhere`, `summarizeResolutions`):
 * the package owns the RULE, each artifact owns its own db call.
 *
 * ── What was actually wrong (read from source, 2026-09-02) ─────────────────
 *
 * OPE-759 offered two hypotheses. Both are wrong.
 *
 * 1. *"Maintained on update, not on create."* Backwards. `create_event_day`
 *    DOES set it — `mcp-server/src/tools/admin.ts:4899`. What is missing is the
 *    other half: **`update_event_day` contains ZERO occurrences of
 *    `flaggedForReview`**, so the self-clear its own tool description promises
 *    ("a non-null value confirms hours and (if it was the last unknown row)
 *    clears the event's flagged_for_review") was **never implemented**. Not
 *    mis-evaluated — absent.
 *
 * 2. *"The clear is evaluated against the row being written."* Directionally
 *    right that it never observes zero, but there is no evaluation at all.
 *
 * The real cause of the under-flagging is neither. **`event_days` has five
 * writers and only one maintained the flag:**
 *
 *   mcp-server/src/tools/admin.ts:4855        create_event_day        ✅
 *   src/lib/events/insert-helpers.ts:102                              ❌
 *   src/lib/series/create-occurrence.ts:101                           ❌
 *   src/app/api/admin/events/[id]/route.ts:513                        ❌
 *   src/app/api/admin/import/route.ts:623                             ❌
 *
 * That is why the seven all-hourless events carry `flagged=0`: their days never
 * went through the one path that flags. Patching `update_event_day` alone would
 * have fixed the specimen and left all seven exactly as they were.
 */
import { isNull, or, sql, type SQL } from "drizzle-orm";
import { eventDays } from "./index";

/** A day whose hours are not fully known. */
export function hoursUnknownWhere(): SQL {
  return or(isNull(eventDays.openTime), isNull(eventDays.closeTime)) as SQL;
}

/**
 * `COUNT` of this event's days whose hours are unknown, as a SQL expression.
 *
 * Counted over the FULL day set rather than tested against the row being
 * written. That is precisely what the specimen needed: filling the fourth of
 * four days has to be able to observe "zero remain", which a per-row predicate
 * structurally cannot do.
 */
export function unknownHoursCountSql(): SQL<number> {
  return sql<number>`sum(case when ${eventDays.openTime} is null or ${eventDays.closeTime} is null then 1 else 0 end)`;
}

/**
 * Should the hours axis raise `events.flagged_for_review`?
 *
 * ⚠️ MONOTONIC BY DESIGN. There is deliberately no `shouldClearHoursFlag`.
 * Read this before "finishing the job" by adding one.
 *
 * `flagged_for_review` is ONE boolean carrying SEVERAL independent reasons.
 * Hours is only one. It is also set by:
 *
 *   src/lib/series/create-occurrence.ts:249    a new series occurrence
 *   src/app/api/admin/import-url/route.ts:418  a URL-imported event
 *   mcp-server/src/event-rollover.ts:254       a rolled-over annual
 *
 * **Nothing records WHY a given row is flagged.** So clearing it because the
 * hours are now complete would silently discharge a rollover's or an import's
 * review obligation — and that is *undecidable from the data*, not merely
 * unchecked: there is no column to consult. OPE-759's suggested fix
 * ("recompute the flag from the event's full day set") would have done exactly
 * that, which is why the ticket marked it a suggestion rather than an
 * acceptance criterion.
 *
 * So this closes the false-NEGATIVE half only. The asymmetry is the reason:
 * over-flagging costs a reviewer one look; under-flagging costs a visitor a
 * wrong answer, and a fair opening in two days with unconfirmed hours is the
 * case the flag exists for.
 */
export function shouldRaiseHoursFlag(counts: {
  daysChecked: number;
  unknownDays: number;
}): boolean {
  // `daysChecked === 0` is NOT "hours confirmed" — it is "no days recorded",
  // which this axis has nothing to say about. Returning true there would flag
  // every season-span event that has no per-date rows yet.
  if (counts.daysChecked <= 0) return false;
  return counts.unknownDays > 0;
}
