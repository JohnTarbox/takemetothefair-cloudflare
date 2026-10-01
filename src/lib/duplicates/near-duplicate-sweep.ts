/**
 * OPE-1201 — a periodic near-duplicate CANDIDATE pass over existing events.
 *
 * ## Why OPE-627's own fixtures were never flagged
 *
 * Read from the source: OPE-627 (#1097, 0efd186e) wired `detectPossibleDuplicate`
 * into the INSERT path of the six intake routes. Nothing re-evaluated rows that
 * already existed — the commit has no backfill, migration or sweep — and every
 * one of its named fixture rows (PTTF / Thornton's Ferry, SSMC / Scarborough HS)
 * was created between 2026-04-16 and 2026-07-11, before it shipped on
 * 2026-08-30. So the check never saw them. `merge_events` does not touch the
 * column either; the rows were NULL because nothing ever wrote them.
 *
 * And the insert check is exact-day on one venue, so two shapes found on
 * 2026-09-28 cannot reach it even going forward: a same-venue twin whose date is
 * wrong by a week (Harvest Festival of Crafts, Oct 23 vs Oct 31; Tanger, Oct 25
 * vs Oct 31), which is the duplicate a bad import produces.
 *
 * ## The predicate (candidate generator, never a verdict)
 *
 * Two live, non-tombstone events at the SAME VENUE, not occurrences of the same
 * series, AND either:
 *   - the same calendar day — OPE-627's own insert predicate, now applied to the
 *     rows that predate it (this is what catches PTTF ↔ Thornton's Ferry, which
 *     share no name token at all); or
 *   - start dates within ±14 days AND ≥1 shared IDENTIFYING name token.
 *
 * "Identifying" is `distinctiveTokens` minus month names, New England state
 * words, and the tokens of the venue's own name and city. Measured on prod
 * 2026-09-28 (825 live upcoming rows) before that refinement, the plain version
 * planned 112 flags and nearly all were noise: weekly farmers-market occurrences
 * a week apart, and pairs sharing only "vermont", "bangor", "november", or the
 * venue's name ("beans greens farm"). Place and month words say where and when an
 * event is — never which event it is.
 *
 * A RECURRING schedule is skipped: at one venue, three or more events with the
 * same identifying-token signature (the weekly Brattleboro / Bangor / Capital
 * City markets, Thompson's Point makers markets). A duplicate is a pair.
 *
 * Deliberately NOT covered: a same-promoter pair at DIFFERENT venues. The
 * measured candidates were legitimate multi-location series (Portland's two
 * farmers markets, Suburban Boston Home Show in Hanover and Wilmington), and a
 * phantom row on the wrong venue (Augusta Civic Center) shares no identifying
 * token with its real twin. Duplicate VENUE rows (Snowport) are caught by the
 * venue candidate check instead, after which the pair shares a venue.
 *
 * ⚠️ NOTHING HERE MERGES. Writing `possible_duplicate_of` is the whole action; the
 * OPE-1117 flag queue (/admin/duplicates/flags) is where a human decides. A pair
 * a human already dismissed (`event_duplicate_dismissals`) is never re-flagged,
 * and a row that already carries a flag is never overwritten.
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { adminActions, eventDuplicateDismissals, events, venues } from "@/lib/db/schema";
import { normalizeName } from "@/lib/duplicates/normalize-name";
import { distinctiveTokens } from "@/lib/duplicates/name-containment";

export const NEAR_DUPLICATE_WINDOW_DAYS = 14;
export const NEAR_DUPLICATE_SWEEP_ACTION = "event.near_duplicate_sweep";

const DAY_MS = 86_400_000;

export interface SweepEventRow {
  id: string;
  name: string;
  venueId: string | null;
  /** The venue's own name and city — their tokens identify the place, not the event. */
  venueName?: string | null;
  venueCity?: string | null;
  seriesId?: string | null;
  promoterId: string | null;
  startDate: Date | null;
  /** OPE-1229 — the range matters: a sub-event sits INSIDE its parent's dates. */
  endDate?: Date | null;
  createdAt: Date | null;
  possibleDuplicateOf: string | null;
}

export type NearDuplicateReason = "same_venue_same_day" | "same_venue_name";

const MONTH_TOKENS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);
const REGION_TOKENS = new Set([
  "maine",
  "vermont",
  "hampshire",
  "massachusetts",
  "connecticut",
  "rhode",
  "island",
  "new",
  "england",
  "north",
  "south",
  "east",
  "west",
]);

/**
 * OPE-1229 — words naming an OCCASION. Two names at one venue that differ by
 * one of these are different occasions of one organizer's calendar, not one
 * event entered twice: "Bangor Elks Lodge Thanksgiving / Christmas Craft Fair",
 * "PVD Artisans Holiday Premiere / Small Business Saturday", "Last Minute …
 * Finale", "Night Before Pumpkin Festival". Seasons are deliberately NOT here:
 * "Fall Harvest" vs "Harvest Festival" (OPE-1201's 8-days-off twin) must pair.
 */
const OCCASION_QUALIFIERS = new Set([
  "thanksgiving",
  "christmas",
  "halloween",
  "easter",
  "valentine",
  "valentines",
  "finale",
  "premiere",
  "preview",
  "kickoff",
  "parade",
  "eve",
]);
const OCCASION_PHRASES = [
  "night before",
  "small business saturday",
  "opening night",
  "closing day",
];

function occasionMarkers(name: string): Set<string> {
  const n = normalizeName(name);
  const out = new Set<string>();
  for (const t of n.split(/\s+/)) if (OCCASION_QUALIFIERS.has(t)) out.add(t);
  for (const ph of OCCASION_PHRASES) if (n.includes(ph)) out.add(ph);
  return out;
}

/** Plain words two names share, generic ones included, place and filler excluded. */
const FILLER = new Set(["of", "the", "and", "at", "in", "on", "a", "an", "for", "to"]);
function sharedPlainWords(a: string, b: string, place: Array<string | null | undefined>): string[] {
  const placeWords = new Set(place.flatMap((p) => (p ? normalizeName(p).split(/\s+/) : [])));
  const words = (s: string) =>
    new Set(
      normalizeName(s)
        .split(/\s+/)
        .filter((w) => w && !FILLER.has(w) && !placeWords.has(w) && !/^\d+$/.test(w))
    );
  const wb = words(b);
  return [...words(a)].filter((w) => wb.has(w));
}

/** Tokens that say WHICH event this is — not where or when. */
export function identifyingTokens(
  name: string,
  place: Array<string | null | undefined>
): Set<string> {
  const placeTokens = new Set(
    place.flatMap((p) => (p ? [...distinctiveTokens(normalizeName(p))] : []))
  );
  return new Set(
    [...distinctiveTokens(normalizeName(name))].filter(
      (t) => !MONTH_TOKENS.has(t) && !REGION_TOKENS.has(t) && !placeTokens.has(t)
    )
  );
}

export interface NearDuplicatePair {
  /** The NEWER row — it gets the flag, pointing at the older one. */
  eventId: string;
  candidateId: string;
  reason: NearDuplicateReason;
  sharedDistinctive: string[];
  startDeltaDays: number;
}

/** Why two events are a near-duplicate candidate, or null. Symmetric. */
export function nearDuplicateReason(
  a: SweepEventRow,
  b: SweepEventRow
): { reason: NearDuplicateReason; sharedDistinctive: string[]; startDeltaDays: number } | null {
  if (a.id === b.id || !a.startDate || !b.startDate) return null;
  if (!a.venueId || a.venueId !== b.venueId) return null;
  // Occurrences of one series share a venue by design — that is not a duplicate.
  if (a.seriesId && a.seriesId === b.seriesId) return null;

  const dayA = a.startDate.toISOString().slice(0, 10);
  const dayB = b.startDate.toISOString().slice(0, 10);
  const startDeltaDays = Math.round(Math.abs(Date.parse(dayA) - Date.parse(dayB)) / DAY_MS);
  if (startDeltaDays > NEAR_DUPLICATE_WINDOW_DAYS) return null;

  const place = [a.venueName, a.venueCity];
  const ta = identifyingTokens(a.name, place);
  const tb = identifyingTokens(b.name, place);
  const sharedDistinctive = [...ta].filter((t) => tb.has(t)).sort();

  // OPE-1229 — the ranges, not just the starts.
  const day = (d: Date) => Date.parse(d.toISOString().slice(0, 10));
  const [sA, eA] = [day(a.startDate), day(a.endDate ?? a.startDate)];
  const [sB, eB] = [day(b.startDate), day(b.endDate ?? b.startDate)];
  const overlap = sA <= eB + DAY_MS && sB <= eA + DAY_MS; // overlapping or touching
  const identical = sA === sB && eA === eB;
  const strictlyContains = (s1: number, e1: number, s2: number, e2: number) =>
    s1 <= s2 && e2 <= e1 && !(s1 === s2 && e1 === e2);

  // A one-day thing inside a month-long thing is a sub-event (the Salem Grand
  // Parade inside Haunted Happenings), not the same event entered twice.
  if (!identical && (strictlyContains(sA, eA, sB, eB) || strictlyContains(sB, eB, sA, eA)))
    return null;

  // Different occasions of one venue's calendar are not duplicates, however
  // close (Thanksgiving vs Christmas fair). Only for ranges that do not overlap:
  // two names for one weekend are still worth a look.
  if (!overlap) {
    const oa = occasionMarkers(a.name);
    const ob = occasionMarkers(b.name);
    const differ = [...oa].some((m) => !ob.has(m)) || [...ob].some((m) => !oa.has(m));
    if (differ) return null;
  }

  if (startDeltaDays === 0) {
    // Same day at a multi-building ground is not enough on its own (Fiber
    // Festival vs Old Deerfield at the Eastern States Exposition): the names
    // must share at least one plain word. PTTF ↔ Thornton's Ferry and the
    // Tanger pair share "craft"/"fair"; the two ESE events share nothing.
    if (sharedPlainWords(a.name, b.name, place).length === 0) return null;
    return { reason: "same_venue_same_day", sharedDistinctive, startDeltaDays };
  }
  if (sharedDistinctive.length >= 1)
    return { reason: "same_venue_name", sharedDistinctive, startDeltaDays };
  return null;
}

const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * Plan which rows to flag. Pure. At most one flag per row (the column holds one
 * id): a row that is already flagged is skipped, and a row this plan already
 * flagged is not flagged again. Candidates are ranked strongest reason first,
 * then closest date, so the one id the column can hold is the best one.
 */
export function planNearDuplicateFlags(
  rows: readonly SweepEventRow[],
  /** Pairs a human ruled NOT duplicates, as `eventId|candidateId` in either order. */
  dismissedPairs: ReadonlySet<string>
): NearDuplicatePair[] {
  const rank: Record<NearDuplicateReason, number> = { same_venue_same_day: 0, same_venue_name: 1 };
  // Only same-venue pairs can match — bucket by venue instead of n².
  const buckets = new Map<string, SweepEventRow[]>();
  for (const r of rows) {
    if (r.venueId) buckets.set(r.venueId, [...(buckets.get(r.venueId) ?? []), r]);
  }

  // A recurring schedule is not a duplicate. Per-date market rows each sit on
  // their own 1:1 series parent (OPE-812), so series_id cannot tell them apart;
  // repetition can. At one venue, THREE OR MORE events with the same identifying
  // signature are a schedule — a duplicate is a pair.
  const signature = (r: SweepEventRow) =>
    [...identifyingTokens(r.name, [r.venueName, r.venueCity])].sort().join(" ");
  const signatureCount = new Map<string, number>();
  for (const r of rows) {
    const sig = signature(r);
    if (!r.venueId || !sig) continue;
    const k = `${r.venueId}|${sig}`;
    signatureCount.set(k, (signatureCount.get(k) ?? 0) + 1);
  }
  const isRecurringPair = (a: SweepEventRow, b: SweepEventRow) => {
    const sa = signature(a);
    return !!sa && sa === signature(b) && (signatureCount.get(`${a.venueId}|${sa}`) ?? 0) >= 3;
  };

  const seen = new Set<string>();
  const candidates: NearDuplicatePair[] = [];
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        const key = pairKey(a.id, b.id);
        if (seen.has(key) || dismissedPairs.has(key)) continue;
        seen.add(key);
        // Already linked in either direction — the queue has it.
        if (a.possibleDuplicateOf === b.id || b.possibleDuplicateOf === a.id) continue;
        if (isRecurringPair(a, b)) continue;
        const why = nearDuplicateReason(a, b);
        if (!why) continue;
        const aNewer =
          (a.createdAt?.getTime() ?? 0) > (b.createdAt?.getTime() ?? 0) ||
          ((a.createdAt?.getTime() ?? 0) === (b.createdAt?.getTime() ?? 0) && a.id > b.id);
        const [newer, older] = aNewer ? [a, b] : [b, a];
        candidates.push({ eventId: newer.id, candidateId: older.id, ...why });
      }
    }
  }

  candidates.sort(
    (x, y) =>
      rank[x.reason] - rank[y.reason] ||
      y.sharedDistinctive.length - x.sharedDistinctive.length ||
      x.startDeltaDays - y.startDeltaDays ||
      x.eventId.localeCompare(y.eventId) ||
      x.candidateId.localeCompare(y.candidateId)
  );

  const alreadyFlagged = new Set(rows.filter((r) => r.possibleDuplicateOf).map((r) => r.id));
  const planned: NearDuplicatePair[] = [];
  for (const c of candidates) {
    if (alreadyFlagged.has(c.eventId)) continue;
    alreadyFlagged.add(c.eventId);
    planned.push(c);
  }
  return planned;
}

export interface NearDuplicateSweepResult {
  dryRun: boolean;
  examined: number;
  planned: NearDuplicatePair[];
  /** Rows actually written (a concurrent writer can make this < planned). */
  written: number;
}

/**
 * Load live upcoming rows, plan, and (unless dryRun) write the flags. Always
 * records one `admin_actions` run row — that row is the heartbeat evidence, so a
 * run that finds nothing still proves the sweep executed.
 */
export async function runNearDuplicateSweep(
  db: Database,
  opts: { now: Date; dryRun: boolean }
): Promise<NearDuplicateSweepResult> {
  const nowSec = Math.floor(opts.now.getTime() / 1000);
  const rows: SweepEventRow[] = await db
    .select({
      id: events.id,
      name: events.name,
      venueId: events.venueId,
      venueName: venues.name,
      venueCity: venues.city,
      seriesId: events.seriesId,
      promoterId: events.promoterId,
      startDate: events.startDate,
      endDate: events.endDate,
      createdAt: events.createdAt,
      possibleDuplicateOf: events.possibleDuplicateOf,
    })
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .where(
      and(
        isNull(events.mergedInto),
        inArray(events.status, ["APPROVED", "TENTATIVE", "PENDING"]),
        // Upcoming only: a past pair is history, not a visitor sent to the wrong day.
        gte(sql`COALESCE(${events.endDate}, ${events.startDate})`, nowSec)
      )
    );

  const dismissals = await db
    .select({ e: eventDuplicateDismissals.eventId, c: eventDuplicateDismissals.candidateId })
    .from(eventDuplicateDismissals);
  const dismissedPairs = new Set(dismissals.map((d) => pairKey(d.e, d.c)));

  const planned = planNearDuplicateFlags(rows, dismissedPairs);

  let written = 0;
  if (!opts.dryRun) {
    for (const p of planned) {
      // Conditional on NULL: never overwrite a flag another path set meanwhile.
      const res = await db
        .update(events)
        .set({ possibleDuplicateOf: p.candidateId })
        .where(and(eq(events.id, p.eventId), isNull(events.possibleDuplicateOf)))
        .returning({ id: events.id });
      written += res.length;
    }
  }

  await db.insert(adminActions).values({
    action: NEAR_DUPLICATE_SWEEP_ACTION,
    actorUserId: null,
    targetType: "events",
    targetId: "near-duplicate-sweep",
    payloadJson: JSON.stringify({
      dryRun: opts.dryRun,
      examined: rows.length,
      planned: planned.length,
      written,
      pairs: planned.slice(0, 200),
    }),
    createdAt: opts.now,
  });

  return { dryRun: opts.dryRun, examined: rows.length, planned, written };
}
