/**
 * OPE-627 — a (venue, calendar day) collision check for every intake path.
 *
 * ## Why `possible_duplicate_of` had 3 rows in 1,939
 *
 * Answered from source, not inferred from the counts. The column has exactly
 * ONE writer: `/api/suggest-event/submit` copies it off the request body
 * (`submit/schema.ts:80` → `submit/route.ts:722`). And exactly one caller ever
 * sets that field — the inbound-EMAIL pipeline
 * (`mcp-server/src/email-handlers/submit.ts:637`), only on its MEDIUM-confidence
 * branch, because HIGH short-circuits before `submitEvent` is called.
 *
 * So of the five intake paths that can create an event — admin create, promoter
 * create, promoter draft, URL import, and public/email submit — the flag is
 * reachable from one, in one branch. Three lifetime rows is exactly what that
 * predicts. It is not gated and not broken; it was never wired to the other four.
 *
 * That is why the four live duplicate pairs span `vendor_submission`,
 * `aggregator_import` and `web_research`, and why one of them is a single
 * promoter's own two rows 45 days apart: nothing on those paths ever asked
 * whether the venue already had an event that day.
 *
 * ## This is a CANDIDATE GENERATOR, and the plain predicate is deliberate
 *
 * Measured base rate on the 2026-08-29 census: **4 true duplicates of 10
 * flagged pairs**. A large fairground legitimately hosts several events at
 * once, so a same-venue/same-day collision is a question, never a verdict.
 *
 * I tried to raise precision and every rule made it WORSE against the real data:
 *
 *   - "end dates must match" DROPS the Logging Festival pair (Jul 17 vs 17-18),
 *     which is the OPE-606 pair this family was filed from.
 *   - "names must share a distinctive token" DROPS PTTF ↔ Thorntons Ferry,
 *     which share none — and the acceptance names that pair explicitly.
 *   - "same promoter" does not rescue it: all five Exeter America-250 events
 *     share promoter 48fa8b58, and the Jul-9 pair also shares {exeter, america},
 *     so every variant still flagged legitimate events while dropping real ones.
 *
 * So the predicate stays plain and the output stays advisory. The signals live
 * on each result as RANKING, not as gates: an operator triaging the queue can
 * see why a pair surfaced, and a false positive costs a glance rather than an
 * event.
 *
 * ⚠️ NOTHING HERE MERGES. Writing `possible_duplicate_of` is the whole action.
 * The acceptance is explicit that flagging the six legitimate pairs is fine and
 * merging any of them is a failure.
 *
 * ## Day granularity is forced, not chosen
 *
 * `start_date` is epoch SECONDS, and 1,377 of 1,897 dated rows (72.6%) carry a
 * noon-UTC placeholder time (`start_date % 86400 = 43200`) — including both
 * sides of all four true pairs. An exact-equality match is therefore already a
 * same-calendar-day match in practice, and the predicate cannot be tightened by
 * demanding the times agree, because they agree by default. Comparing
 * `date(...,'unixepoch')` says what is actually meant.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events } from "@/lib/db/schema";
import { normalizeName } from "@/lib/duplicates/normalize-name";
import { distinctiveTokens } from "@/lib/duplicates/name-containment";

export interface VenueDateCollisionInput {
  /**
   * Nullable on purpose. Several intake paths legitimately create an event with
   * no venue (a draft, an import that could not resolve one), and a check that
   * threw on those would turn a detector into an outage. No venue or no start
   * date simply means there is nothing to collide on.
   */
  venueId: string | null | undefined;
  startDate: Date | null | undefined;
  endDate?: Date | null;
  name: string;
  promoterId?: string | null;
  /** Exclude the row being updated, so an edit never flags itself. */
  excludeEventId?: string;
}

export interface VenueDateCollision {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** Triage signal: distinctive tokens both names share (generic words dropped). */
  sharedDistinctive: string[];
  /** Triage signal: |end-date difference| in days, or null when either is unset. */
  endDateDeltaDays: number | null;
  /** Triage signal: the strongest one in this census — PTTF was one promoter's own two rows. */
  samePromoter: boolean;
}

/** Whole days between two dates, rounded — the column is day-granular anyway. */
function dayDelta(a: Date | null | undefined, b: Date | null | undefined): number | null {
  if (!a || !b) return null;
  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Publicly-visible events at the same venue on the same calendar day.
 *
 * Merge tombstones are excluded for the same reason `find-duplicate.ts` excludes
 * them (OPE-432): a tombstone's slug 301s to its keeper, so offering one as a
 * duplicate hands the caller a URL that redirects away.
 *
 * No status filter beyond the tombstone exclusion, matching `findDuplicate` and
 * the OPE-437 guard — dedup must keep seeing PENDING rows, which is precisely
 * the queue an intake-time check is racing against.
 */
export async function findVenueDateCollisions(
  db: Database,
  input: VenueDateCollisionInput
): Promise<VenueDateCollision[]> {
  if (!input.venueId || !input.startDate) return [];

  const startEpoch = Math.floor(input.startDate.getTime() / 1000);
  const conditions = [
    eq(events.venueId, input.venueId),
    isNull(events.mergedInto),
    sql`date(${events.startDate}, 'unixepoch') = date(${startEpoch}, 'unixepoch')`,
  ];
  if (input.excludeEventId) conditions.push(ne(events.id, input.excludeEventId));

  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      status: events.status,
      startDate: events.startDate,
      endDate: events.endDate,
      promoterId: events.promoterId,
    })
    .from(events)
    .where(and(...conditions))
    // Deterministic ordering, same reasoning as OPE-432: APPROVED first because
    // a published event is the one an operator can actually go and look at,
    // `id` to break the remaining tie so repeated calls agree.
    .orderBy(sql`CASE WHEN ${events.status} = 'APPROVED' THEN 0 ELSE 1 END`, events.id)
    .limit(25);

  const mine = distinctiveTokens(normalizeName(input.name));

  return rows.map((r) => {
    const theirs = distinctiveTokens(normalizeName(r.name));
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      sharedDistinctive: [...mine].filter((t) => theirs.has(t)).sort(),
      endDateDeltaDays: dayDelta(input.endDate ?? null, r.endDate),
      samePromoter: !!input.promoterId && r.promoterId === input.promoterId,
    };
  });
}

/**
 * Which collision to record in `possible_duplicate_of`, or null.
 *
 * One column, possibly several candidates, so this picks the one an operator
 * should look at FIRST. Ranking only — every candidate was already returned,
 * and a lower-ranked one is not dismissed, just not the single id the column
 * can hold.
 *
 * Order: same promoter, then more shared distinctive tokens, then a closer end
 * date. That is the order the census supports — the same-promoter pair (PTTF)
 * is the one with no name overlap at all, so a name-first ranking would bury
 * the strongest signal in the set.
 */
export function pickPrimaryCollision(
  collisions: readonly VenueDateCollision[]
): VenueDateCollision | null {
  if (collisions.length === 0) return null;
  return [...collisions].sort((a, b) => {
    if (a.samePromoter !== b.samePromoter) return a.samePromoter ? -1 : 1;
    if (a.sharedDistinctive.length !== b.sharedDistinctive.length) {
      return b.sharedDistinctive.length - a.sharedDistinctive.length;
    }
    const ad = a.endDateDeltaDays ?? Number.MAX_SAFE_INTEGER;
    const bd = b.endDateDeltaDays ?? Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/**
 * The one call an intake path makes: returns the id to store in
 * `possible_duplicate_of`, or null.
 *
 * Fail-open by design. A detector fault must never block a real submission —
 * the cost of a missed flag is one row in a triage queue, and the cost of a
 * thrown intake is a person's event not existing. It logs nothing here because
 * every caller is already inside a request with its own error handling; the
 * null is the whole contract.
 */
export async function detectPossibleDuplicate(
  db: Database,
  input: VenueDateCollisionInput
): Promise<string | null> {
  try {
    return pickPrimaryCollision(await findVenueDateCollisions(db, input))?.id ?? null;
  } catch {
    return null;
  }
}
