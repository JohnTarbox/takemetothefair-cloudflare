/**
 * OPE-450 — has a human already ruled on this exact candidate?
 *
 * Detection was never the problem. A shell event lifted from a marketing
 * newsletter's boilerplate footer was rejected by hand on 2026-07-28; the same
 * template produced the same shell on 2026-08-17 and it was created again.
 * `possible_duplicate_of` was stamped BOTH times, the `ok-medium-dup` reply went
 * out BOTH times, and the slug collided into a `-2` suffix — three layers saw
 * it. None asked whether the decision had already been made.
 *
 * ── Why this does NOT key on `possible_duplicate_of` ──────────────────────
 *
 * The ticket proposed keying on `possible_duplicate_of = K AND status =
 * 'REJECTED'`. Measured against prod on 2026-08-18: `possible_duplicate_of` is
 * non-null on exactly **2 rows in the entire events table** — both shells from
 * this single incident. That check would catch the reported case and almost
 * nothing else.
 *
 * Keyed instead on (normalized name, start_date) + a prior REJECTED row, the
 * same shape has occurred **5 times**:
 *
 *   New England Made Autumn Show 2026   rejected 07-28 → recreated 08-17
 *   Bar Harbor Holiday Craft Fair 2026  rejected 01-27 → recreated 08-14
 *   Vermont Sheep & Wool Festival 2026  rejected 05-05 → recreated 06-01
 *   Bonny Eagle Craft Fair 2026         rejected 04-29 → recreated 05-02
 *   Hopkinton State Fair 2026           rejected 04-24 → recreated 05-02
 *
 * All five recreations were re-rejected by hand.
 *
 * A caution that matters for reading that number: **12** (name, date) groups
 * contain both an APPROVED and a REJECTED row, but in 7 of them the approved
 * row came FIRST and the duplicate was rejected afterwards — the system working
 * correctly. Only a create that POSTDATES a rejection is this defect. Counting
 * the 12 would have overstated it by more than double.
 *
 * ── What counts as an adjudication ────────────────────────────────────────
 *
 * Deliberately narrow. A REJECTED row alone is NOT enough: events are rejected
 * for many reasons (spam, past-dated, wrong region), and treating every
 * rejection as "never accept this name+date again" would silently suppress
 * legitimate resubmissions — a far worse failure than the duplicate this
 * prevents, because it is invisible. So a match requires the rejection to be
 * *about duplication*:
 *
 *   - `rejected_as_duplicate_of` set (drizzle/0202) — a human's decision, or
 *   - `merged_into` set — the row was merged away, which is the same ruling
 *     reached by a different route.
 *
 * `possible_duplicate_of` on its own is explicitly NOT sufficient: it records
 * that a matcher was suspicious, not that anyone agreed.
 */

import { and, eq, gte, isNotNull, lte, or } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events } from "@/lib/db/schema";
import { normalizeName } from "@/lib/duplicates/normalize-name";

export interface PriorAdjudicationInput {
  /** Candidate event name, as submitted. */
  name?: string | null;
  /** Candidate start date, YYYY-MM-DD or any Date-parseable string. */
  startDate?: string | null;
}

export interface PriorAdjudication {
  /** The already-adjudicated row. */
  rejectedEventId: string;
  rejectedEventName: string;
  /** The keeper it was ruled a duplicate of, when known. */
  keeperEventId: string | null;
  /** Which field carried the ruling — useful in logs and operator output. */
  basis: "rejected_as_duplicate_of" | "merged_into";
}

/**
 * Returns the prior ruling on this candidate, or null when none exists.
 *
 * Read-only. The caller decides what to do with a hit — this deliberately does
 * not suppress anything itself, so the policy stays visible at the call site
 * rather than buried in a lookup.
 */
export async function findPriorAdjudication(
  db: Database,
  input: PriorAdjudicationInput
): Promise<PriorAdjudication | null> {
  if (!input.name || !input.startDate) return null;

  const normalized = normalizeName(input.name);
  if (!normalized) return null;

  const parsed = new Date(input.startDate);
  if (isNaN(parsed.getTime())) return null;

  // Exact start_date, not a window. A ±7d window is right for "is this the same
  // event?" (dates drift between sources); it is wrong here, where the question
  // is "is this the same CANDIDATE a human already saw?". Widening it would let
  // one rejection suppress a genuinely different edition a few days apart.
  const dayStart = new Date(parsed);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const candidates = await db
    .select({
      id: events.id,
      name: events.name,
      rejectedAsDuplicateOf: events.rejectedAsDuplicateOf,
      mergedInto: events.mergedInto,
    })
    .from(events)
    .where(
      and(
        eq(events.status, "REJECTED"),
        // gte/lte on the column, NOT a raw sql`` template: the raw form binds a
        // JS Date straight through and never applies the column's timestamp
        // mapper, which fails at the driver ("can only bind numbers, strings,
        // bigints, buffers, and null"). Caught by the tests below.
        gte(events.startDate, dayStart),
        lte(events.startDate, dayEnd),
        // The ruling must be about duplication — see the header note on why a
        // bare REJECTED is not enough.
        or(isNotNull(events.rejectedAsDuplicateOf), isNotNull(events.mergedInto))
      )
    )
    .limit(50);

  for (const row of candidates) {
    if (!row.name || normalizeName(row.name) !== normalized) continue;
    return {
      rejectedEventId: row.id,
      rejectedEventName: row.name,
      keeperEventId: row.rejectedAsDuplicateOf ?? row.mergedInto ?? null,
      basis: row.rejectedAsDuplicateOf ? "rejected_as_duplicate_of" : "merged_into",
    };
  }
  return null;
}
