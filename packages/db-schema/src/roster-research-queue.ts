/**
 * OPE-528 — who is actually a vendor-roster research target.
 *
 * The NEEDS_RESEARCH queue counted rows that no amount of research could ever
 * move to a terminal status, and the drain selects from it `end_date_desc`, so
 * the un-closeable rows sat at the TOP of the worklist.
 *
 * Measured in prod 2026-08-23/24, `vendor_roster_status='NEEDS_RESEARCH'`:
 *
 *     520  APPROVED, not a tombstone      <- the real queue
 *     128  ...of which weekly farmers-market occurrences
 *       8  REJECTED, not a tombstone      <- carrying a research obligation
 *       3  REJECTED merge tombstones      <- already dropped by coverage only
 *     ---
 *     531  total
 *
 * Those 3 tombstones are the entire unexplained "547 vs 544" gap the ticket
 * flagged as an unverified mechanism: the coverage route filtered
 * `merged_into IS NULL` and `list_all_events` did not. It was a rule, not a
 * glitch — but only one of the two surfaces knew it.
 *
 * ── Why category, and not series ──────────────────────────────────────────
 *
 * The ticket's preferred shape was one roster verdict per SERIES. That cannot
 * work on today's data: those 520 rows carry **520 distinct `series_id`s**.
 * Farmers markets get one series per market DATE (the same quirk OPE-473 hit
 * when consolidating duplicate parents), so a series-level verdict would still
 * be a per-week verdict. The names do not group either — each occurrence
 * carries its own date-stamped or invented name ("Rutland Downtown Summer
 * Farmers Market — 2026-08-22", "Vermont 3rd Saturday Farmers Market 2026").
 *
 * So the only stable grouping key on this data is the category, and it happens
 * to be the honest one: the `event-vendor-roster-backfill` skill lists weekly
 * farmers markets under "usually NOT findable" because they do not publish
 * exhibitor rosters at all.
 *
 * ── Excluded, never discarded ─────────────────────────────────────────────
 *
 * These rows stay perfectly valid events and stay COUNTED — the coverage route
 * reports them as their own totals rather than dropping them. A number that
 * silently shrinks is indistinguishable from a queue that drained, which is the
 * failure this whole rail keeps hitting.
 */
import { and, eq, isNull, not, like, sql, type SQL } from "drizzle-orm";
import { events } from "./index";

/**
 * Category tokens whose events are not roster-research targets.
 *
 * Matched case-insensitively against the JSON `categories` array, which is
 * stored as a JSON string in SQLite — hence LIKE rather than a containment
 * operator. Substring matching is safe here because these are full category
 * names, not fragments that could appear inside another.
 */
export const NON_ROSTER_RESEARCH_CATEGORIES = ["Farmers Market"] as const;

/** Only an APPROVED event carries a research obligation. A REJECTED one is a
 *  decision already taken; researching it cannot change anything. */
export const ROSTER_RESEARCH_STATUSES = ["APPROVED"] as const;

/** True when the row's categories name a class we do not research. */
export function isNonResearchCategory(): SQL {
  // COALESCE is load-bearing, not defensive tidiness. `categories` is nullable,
  // and in SQL `lower(NULL) LIKE '%x%'` is NULL, so `NOT (...)` is also NULL and
  // the row fails the filter. Without this, every event with no categories —
  // i.e. everything unclassified — would vanish from the research queue, which
  // is a far worse bug than the one being fixed. Caught by the "keeps an event
  // with no categories at all" test, which is why that test exists.
  const clauses = NON_ROSTER_RESEARCH_CATEGORIES.map((c) =>
    like(sql`lower(coalesce(${events.categories}, ''))`, `%${c.toLowerCase()}%`)
  );
  // One element today; `or` would be the shape for several.
  return clauses.length === 1 ? clauses[0] : sql`(${sql.join(clauses, sql` OR `)})`;
}

/**
 * The single definition of "this row is a vendor-roster research target",
 * shared by the MCP `list_all_events` queue filter and the main app's
 * `get_roster_coverage` totals so the two cannot disagree — they differed by 3
 * with no stated rule until this existed.
 */
export function rosterResearchTargetWhere(): SQL {
  return and(
    isNull(events.mergedInto),
    eq(events.status, ROSTER_RESEARCH_STATUSES[0]),
    not(isNonResearchCategory())
  ) as SQL;
}

/**
 * OPE-713 — "is this row producer-class", as one testable expression.
 *
 * Extracted for the reason `vendorSearchWhere` was (OPE-632/OPE-566): a
 * predicate that decides a published metric's denominator, and that nothing
 * outside the route could run, drifted from what readers believed it did. A
 * roster pass on 2026-08-31 added 530 links and moved `coveragePct` by 0.4pp;
 * the ticket inferred from the outcomes that `event_scale` gated membership.
 * Scale is not in this predicate at all — membership keys on `categories`. The
 * wrong inference was reasonable precisely because the rule was unreadable
 * from outside.
 *
 * The category list is a PARAMETER rather than an import so this package does
 * not take a dependency on `@takemetothefair/constants` (the caller owns the
 * vocabulary; this owns the SQL). It also lets a test pin the NULL-handling
 * without pinning the business list.
 *
 * ⚠️ `coalesce` here is load-bearing for the NEGATED form, exactly as it is in
 * `isNonResearchCategory` above, and for the same reason: `NULL LIKE '%x%'` is
 * NULL, so `NOT (...)` is NULL and the row fails the filter. An uncategorised
 * event would drop out of `pastNonProducerClassWhere` — the one query whose
 * whole job is to count uncategorised events. Covered by a test that seeds a
 * row with NULL categories and requires it to appear.
 */
export function producerClassCond(categories: readonly string[]): SQL {
  const text = sql`coalesce(${events.categories}, '[]')`;
  // Match `%"Home Show"%` including the quotes: the column holds a JSON array,
  // and an unquoted match would let "Craft Fair" hit a hypothetical
  // "Craft Fairground". These are constants, never user input, so the pattern
  // cannot approach D1's 50-character LIKE cap.
  const clauses = categories.map((c) => like(text, `%"${c}"%`));
  if (clauses.length === 0) return sql`0`;
  return clauses.length === 1 ? clauses[0] : sql`(${sql.join(clauses, sql` OR `)})`;
}

/** Past producer-class events: the `producerClass` coverage denominator. */
export function pastProducerClassWhere(categories: readonly string[]): SQL {
  return and(
    eq(events.lifecycleStatus, "OCCURRED"),
    isNull(events.mergedInto),
    producerClassCond(categories)
  ) as SQL;
}

/**
 * Past OCCURRED events that are NOT producer-class — the population
 * `coveragePct` cannot see. Reported, never dropped: a drain that completes a
 * 93-exhibitor roster deserves to find out why its number did not move.
 */
export function pastNonProducerClassWhere(categories: readonly string[]): SQL {
  return and(
    eq(events.lifecycleStatus, "OCCURRED"),
    isNull(events.mergedInto),
    not(producerClassCond(categories))
  ) as SQL;
}

/** True when a row carries no categories at all — a DATA gap, distinct from
 *  carrying categories that are simply not producer-class. The two need
 *  opposite remedies, so they are counted separately. */
export function hasNoCategories(): SQL {
  return sql`coalesce(${events.categories}, '[]') in ('[]', '')`;
}
