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
 *   1. exact_url       — events.source_url equality
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

export type MatchType = "exact_url" | "venue_date" | "city_state_date" | "similar_name_date";

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

  // ── Stage 1: exact source_url match ──────────────────────────────
  if (input.sourceUrl) {
    const exactMatch = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        startDate: events.startDate,
        status: events.status,
        sourceUrl: events.sourceUrl,
      })
      .from(events)
      .where(eq(events.sourceUrl, input.sourceUrl))
      .limit(1);
    if (exactMatch.length > 0) {
      return {
        isDuplicate: true,
        matchType: "exact_url",
        existingEvent: toExisting(exactMatch[0]),
      };
    }
  }

  // No startDate → no place/name matching is meaningful. Stages 2-4
  // all need a date window.
  if (!input.startDate) {
    return { isDuplicate: false };
  }

  const eventDate = new Date(input.startDate);
  if (isNaN(eventDate.getTime())) {
    return { isDuplicate: false };
  }
  const dateRangeMs = dateWindowDays * 24 * 60 * 60 * 1000;
  const minDate = new Date(eventDate.getTime() - dateRangeMs);
  const maxDate = new Date(eventDate.getTime() + dateRangeMs);

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
            gte(events.startDate, minDate),
            lte(events.startDate, maxDate)
          )
        )
        .limit(1);
      if (venueMatch.length > 0) {
        return {
          isDuplicate: true,
          matchType: "venue_date",
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
            gte(events.startDate, minDate),
            lte(events.startDate, maxDate)
          )
        )
        .limit(1);
      if (cityStateMatch.length > 0) {
        return {
          isDuplicate: true,
          matchType: "city_state_date",
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
      .where(and(gte(events.startDate, minDate), lte(events.startDate, maxDate)));
    for (const ev of similarEvents) {
      if (!ev.name) continue;
      const existingNormalized = normalizeName(ev.name);
      const sim = similarity(normalizedName, existingNormalized);
      if (sim > nameThreshold) {
        return {
          isDuplicate: true,
          matchType: "similar_name_date",
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
 */
function similarity(s1: string, s2: string): number {
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
