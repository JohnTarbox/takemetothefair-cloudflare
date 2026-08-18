/**
 * Shared duplicate-detection helper.
 *
 * K2 part 4 (analyst, 2026-05-31). Extracted from the
 * /api/suggest-event/check-duplicate route so the same matching logic
 * can run inside the email pipeline's enrich-or-flag step (Part 5),
 * the admin dedup sweep (Part 6), and any future creation path.
 * Keeping ONE function as the source of truth prevents the kind of
 * silent divergence that drove the Winthrop duplicate (PENDING
 * 25ef60f0 vs APPROVED 4ee1de4a) — the same class as the slug-
 * generator divergence in [[project_event_insert_paths]].
 *
 * Match-stage order (first hit wins):
 *   1. exact_url       — events.source_url equality AND dates agree
 *      series_url      — events.source_url equality, dates DISAGREE
 *   2. venue_date      — autoLinkVenue resolves a venueId; existing
 *                        events at that venue within ±dateWindowDays
 *   3. city_state_date — venues.city + venues.state join; existing
 *                        events in the same town ±dateWindowDays
 *   4. similar_name_date — Levenshtein-similarity > nameThreshold on
 *                        normalizeName(name), within ±dateWindowDays
 *
 * Each stage that hits returns the existing event + matchType. No
 * hit → { isDuplicate: false }. Caller decides what to do with the
 * result (route reply, enrich, flag PENDING, log audit).
 *
 * ── OPE-454: a shared source_url means SAME SOURCE, not SAME EVENT ──
 *
 * Stage 1 used to be `where(source_url = ?) limit 1`, short-circuiting
 * before any date comparison and returning an ARBITRARY row. For a series
 * promoter who lists every show on one `/shows` page, that made each
 * edition a "duplicate" of its siblings. Two legitimate 2027 Paradise City
 * shows — different cities, a year apart — were both refused against a
 * November 2026 event whose only commonality was the URL.
 *
 * Measured 2026-08-17: **738 of 1,748 events carrying a source_url (42%)
 * share it with at least one other event**, across 195 URLs; the worst
 * single URL is on 53 events. So this was not an edge case — a large
 * fraction of the catalog sits in the collision zone.
 *
 * The tell that this was a semantic confusion rather than a threshold bug:
 * `maybeRouteToOccurrence` (src/lib/discovery/route-to-occurrence.ts)
 * deliberately depends on stage 1 matching ACROSS years, and reads it
 * correctly — same URL + different year ⇒ a new occurrence of the same
 * series. The creation paths read the identical signal as "same event" and
 * refuse. One signal, two incompatible meanings.
 *
 * So the split is by meaning, not by strictness:
 *
 *   exact_url  — same URL AND the dates agree (or there is no candidate
 *                date and the URL identifies exactly one event). This
 *                really is the same event. Still a blocking duplicate.
 *   series_url — same URL, dates disagree (or the URL is a directory page
 *                on 2+ events, so it cannot identify which). Same source,
 *                different edition. NOT a blocking duplicate.
 *
 * `series_url` still returns `isDuplicate: true` so the series-routing
 * consumer keeps working unchanged. Blocking is expressed by the separate
 * `identifiesSameEvent` flag: a consumer that has not been taught about
 * `series_url` keeps TODAY's behavior (over-refusing) rather than newly
 * creating duplicates — the fail-safe direction for a dedup guard.
 *
 * Note the ticket's suggested rule ("a URL on 2+ events is a directory
 * page") would NOT have fixed the reported case: at the moment of refusal
 * only ONE Paradise City event carried that URL, so the count was 1 and the
 * rule would not have fired. The date comparison is what does the work; the
 * 2+ count only covers the undated case.
 *
 * Deferred to a follow-up PR (per the K2 plan): rewire the
 * suggest_event / update_event MCP tools (vendor.ts:772-788,
 * admin.ts:861-911) through this helper. Those paths today use an
 * overlap-based date predicate (`existing.start <= newEnd AND
 * coalesce(existing.end, existing.start) >= newStart`) instead of the
 * ±7-day window used here, and surface possible_duplicates as
 * warnings rather than blocking duplicates. Unifying them is a
 * behavior change that needs its own audit + PR.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events, venues } from "@/lib/db/schema";
import { autoLinkVenue } from "@/lib/venue-matching";
import { normalizeName } from "@/lib/duplicates/normalize-name";

export interface FindDuplicateInput {
  /** Original-source URL of the candidate. Exact-match shortcut. */
  sourceUrl?: string | null;
  /** Candidate event name. Used only for the similar_name_date tiebreaker. */
  name?: string | null;
  /** Candidate start date as YYYY-MM-DD or any Date-parseable string. */
  startDate?: string | null;
  /** Raw venue strings. Resolved server-side via autoLinkVenue. */
  venueName?: string | null;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  /** Date-window for matches in days. Default 7. */
  dateWindowDays?: number;
  /** Similarity threshold for the name fallback (0..1). Default 0.85. */
  nameThreshold?: number;
}

export type MatchType =
  | "exact_url"
  | "series_url"
  | "venue_date"
  | "city_state_date"
  | "similar_name_date";

/**
 * OPE-454 — the match types that identify the SAME EVENT, and so should
 * block creation. `series_url` identifies the same SOURCE only.
 *
 * Exported so consumers express the decision by asking this question rather
 * than by re-listing match types, which is how the four call sites drifted
 * apart in the first place.
 */
export function identifiesSameEvent(matchType: MatchType): boolean {
  return matchType !== "series_url";
}

export interface ExistingEvent {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  status: string;
  sourceUrl: string | null;
}

export type FindDuplicateResult =
  | { isDuplicate: false }
  | {
      isDuplicate: true;
      matchType: MatchType;
      similarity?: number; // only on similar_name_date
      /**
       * OPE-454 — true when the match means "this is the same event"
       * (blocking); false when it only means "this came from the same
       * source page" (`series_url`). Mirrors `identifiesSameEvent(matchType)`
       * and is surfaced on the result so a caller cannot forget to ask.
       */
      identifiesSameEvent: boolean;
      existingEvent: ExistingEvent;
    };

/**
 * Run the 4-stage dedup match against the supplied candidate. Returns
 * the first hit, or { isDuplicate: false } when nothing matches.
 */
export async function findDuplicate(
  db: Database,
  input: FindDuplicateInput
): Promise<FindDuplicateResult> {
  const dateWindowDays = input.dateWindowDays ?? 7;
  const nameThreshold = input.nameThreshold ?? 0.85;

  // The date window is computed BEFORE stage 1 (OPE-454) because stage 1
  // now needs it: a shared source_url only means "same event" when the
  // dates also agree. Previously stage 1 ran first and returned before any
  // date was parsed, which is precisely how a different-year edition became
  // a duplicate of its sibling.
  const dateRangeMs = dateWindowDays * 24 * 60 * 60 * 1000;
  const eventDate = input.startDate ? new Date(input.startDate) : null;
  const haveDate = eventDate !== null && !isNaN(eventDate.getTime());
  const minDate = haveDate ? new Date(eventDate.getTime() - dateRangeMs) : null;
  const maxDate = haveDate ? new Date(eventDate.getTime() + dateRangeMs) : null;

  const eventColumns = {
    id: events.id,
    slug: events.slug,
    name: events.name,
    startDate: events.startDate,
    status: events.status,
    sourceUrl: events.sourceUrl,
  };

  // ── Stage 1: source_url — same event (exact_url) vs same source (series_url) ──
  if (input.sourceUrl) {
    // 1a. Same URL *and* the dates agree → genuinely the same event.
    if (haveDate) {
      const sameUrlAndDate = await db
        .select(eventColumns)
        .from(events)
        .where(
          and(
            eq(events.sourceUrl, input.sourceUrl),
            gte(events.startDate, minDate!),
            lte(events.startDate, maxDate!)
          )
        )
        .limit(1);
      if (sameUrlAndDate.length > 0) {
        return {
          isDuplicate: true,
          matchType: "exact_url",
          identifiesSameEvent: true,
          existingEvent: toExisting(sameUrlAndDate[0]),
        };
      }
    }

    // 1b. Same URL, dates disagree (or no candidate date). `limit(2)` is
    // enough to answer "is this URL on more than one event?" without
    // dragging back all 53 rows of the worst offender.
    const sameUrl = await db
      .select(eventColumns)
      .from(events)
      .where(eq(events.sourceUrl, input.sourceUrl))
      .limit(2);

    if (sameUrl.length > 0) {
      // An undated candidate against a URL that names exactly ONE event is
      // the original intent of this stage — a re-submission of the same
      // page with a date we failed to parse. Nothing contradicts it, so it
      // stays a blocking duplicate.
      const unambiguousUndated = !haveDate && sameUrl.length === 1;
      return {
        isDuplicate: true,
        matchType: unambiguousUndated ? "exact_url" : "series_url",
        identifiesSameEvent: unambiguousUndated,
        existingEvent: toExisting(sameUrl[0]),
      };
    }
  }

  // No startDate → no place/name matching is meaningful. Stages 2-4
  // all need a date window.
  if (!haveDate || minDate === null || maxDate === null) {
    return { isDuplicate: false };
  }
  // Re-bound as non-null for stages 2-4. `haveDate` is a plain boolean, so
  // TypeScript cannot narrow minDate/maxDate through it on its own.
  const windowStart: Date = minDate;
  const windowEnd: Date = maxDate;

  // ── Stages 2a + 2b: place + date ─────────────────────────────────
  const hasPlaceSignal = !!input.venueName || !!(input.venueCity && input.venueState);

  if (hasPlaceSignal) {
    // 2a — try to resolve venueId server-side. Both "linked" and
    // "address-corroborated" decisions return a confident venueId;
    // "ambiguous" / "no-match" / "no-name" leave it null and we fall
    // through to the city+state branch.
    let resolvedVenueId: string | null = null;
    if (input.venueName) {
      const linked = await autoLinkVenue(db, {
        venueName: input.venueName,
        venueAddress: input.venueAddress ?? null,
        venueCity: input.venueCity ?? null,
        venueState: input.venueState ?? null,
      });
      if (linked.venueId) resolvedVenueId = linked.venueId;
    }

    if (resolvedVenueId) {
      const venueMatch = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          startDate: events.startDate,
          status: events.status,
          sourceUrl: events.sourceUrl,
        })
        .from(events)
        .where(
          and(
            eq(events.venueId, resolvedVenueId),
            gte(events.startDate, windowStart),
            lte(events.startDate, windowEnd)
          )
        )
        .limit(1);
      if (venueMatch.length > 0) {
        return {
          isDuplicate: true,
          matchType: "venue_date",
          identifiesSameEvent: true,
          existingEvent: toExisting(venueMatch[0]),
        };
      }
    }

    // 2b — venue couldn't be resolved OR didn't yield a match. Try
    // city + state on the venue join.
    if (input.venueCity && input.venueState) {
      const normalizedCity = input.venueCity.trim();
      const normalizedState = input.venueState.trim().toUpperCase();
      const cityStateMatch = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          startDate: events.startDate,
          status: events.status,
          sourceUrl: events.sourceUrl,
        })
        .from(events)
        .innerJoin(venues, eq(events.venueId, venues.id))
        .where(
          and(
            // Case-insensitive city — different ingestion paths can
            // disagree on capitalization ("Winthrop" vs "winthrop").
            sql`LOWER(${venues.city}) = LOWER(${normalizedCity})`,
            eq(venues.state, normalizedState),
            gte(events.startDate, windowStart),
            lte(events.startDate, windowEnd)
          )
        )
        .limit(1);
      if (cityStateMatch.length > 0) {
        return {
          isDuplicate: true,
          matchType: "city_state_date",
          identifiesSameEvent: true,
          existingEvent: toExisting(cityStateMatch[0]),
        };
      }
    }
  }

  // ── Stage 3: name + date similarity (legacy tiebreaker) ──────────
  if (input.name) {
    const normalizedName = normalizeName(input.name);
    const similarEvents = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        startDate: events.startDate,
        status: events.status,
        sourceUrl: events.sourceUrl,
      })
      .from(events)
      .where(and(gte(events.startDate, windowStart), lte(events.startDate, windowEnd)));
    for (const ev of similarEvents) {
      if (!ev.name) continue;
      const existingNormalized = normalizeName(ev.name);
      const sim = similarity(normalizedName, existingNormalized);
      if (sim > nameThreshold) {
        return {
          isDuplicate: true,
          matchType: "similar_name_date",
          identifiesSameEvent: true,
          similarity: sim,
          existingEvent: toExisting(ev),
        };
      }
    }
  }

  return { isDuplicate: false };
}

function toExisting(row: {
  id: string;
  slug: unknown;
  name: string;
  startDate: Date | null;
  status: string;
  sourceUrl: string | null;
}): ExistingEvent {
  return {
    id: row.id,
    slug: row.slug as string,
    name: row.name,
    startDate: row.startDate,
    status: row.status,
    sourceUrl: row.sourceUrl,
  };
}

/**
 * Levenshtein-distance similarity ratio, 0..1. Kept inline rather than
 * pulled from a package because the existing route also computed it
 * inline — this is the bit-for-bit same implementation.
 *
 * Exported for GW1.1 (ingest_addverify capture, 2026-06-03) so the
 * ingest-discrepancy comparator can apply the same threshold against
 * candidate vs existing event names. Single source of truth — don't
 * inline a parallel copy in the comparator.
 */
export function similarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  if (longer.length === 0) return 1.0;

  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) {
      costs[s2.length] = lastValue;
    }
  }
  const distance = costs[s2.length];
  return (longer.length - distance) / longer.length;
}
