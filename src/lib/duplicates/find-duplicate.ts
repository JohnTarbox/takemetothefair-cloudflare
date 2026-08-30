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
 *   1. exact_url       — events.source_url equality AND the SAME CALENDAR DAY
 *      series_url      — events.source_url equality, a different day (OPE-650)
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
 *   exact_url  — same URL AND the same calendar day (or there is no candidate
 *                date and the URL identifies exactly one event). This
 *                really is the same event. Still a blocking duplicate.
 *
 *                OPE-650: "the dates agree" was implemented as the ±7-day
 *                window shared with stages 2-4, and a weekly series is 7 days
 *                apart — so an organizer listing a season on one page had every
 *                event after the first refused against its sibling. Same day is
 *                what this stage always meant.
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
 * ⚠️ STALE NOTE CORRECTED (OPE-650, 2026-08-30). This paragraph used to say the
 * suggest_event / update_event rewire was "deferred to a follow-up PR" and that
 * those tools still ran their own overlap-based dedup. That has been untrue
 * since the K2 rewire. Verified by reading the chain:
 *
 *   suggest_event (mcp-server/src/tools/vendor.ts:1024)
 *     -> checkDuplicateViaMainApp (mcp-server/src/duplicates/check-duplicate.ts:94)
 *       -> POST /api/suggest-event/check-duplicate
 *         -> findDuplicate  (this file)
 *
 * So there is exactly ONE dedup implementation and a change here reaches the MCP
 * tools too — which is why OPE-650's fix below needed no second edit. Left as a
 * correction rather than deleted: a stale "this is deferred" note is precisely
 * what produces a fix wired into one of two parallel paths, and this one had
 * already outlived its truth by ten weeks.
 *
 * What still differs between the tools is what they DO with a hit, not how they
 * find it: `suggest_event` blocks (overridable by `force_create`), while
 * `update_event` is warning-only.
 */

import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events, venues } from "@/lib/db/schema";
import { autoLinkVenue } from "@/lib/venue-matching";
import { normalizeName } from "@/lib/duplicates/normalize-name";
import { nameContainmentMatch } from "@/lib/duplicates/name-containment";

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
  | "similar_name_date"
  // OPE-477 — the venue-less fallback. Only reachable when BOTH venue stages
  // were inert, so it never widens matching for a candidate that had a venue.
  | "name_containment_date";

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

/**
 * OPE-477 — which stages could not evaluate for this candidate.
 *
 * The defect this names: a stage with a missing input returned nothing, and
 * "nothing" was indistinguishable from "checked and cleared". A caller that
 * blocks on `isDuplicate` alone cannot tell whether dedup ran on four stages or
 * on one. Now it can.
 *
 * Reported on BOTH result shapes deliberately — a hit on a weak stage while the
 * strong ones were blind is still worth knowing about.
 */
export type SkippedStage =
  | "exact_url:no-source-url"
  | "venue_date:venue-unresolved"
  | "city_state_date:no-city-state"
  | "similar_name_date:no-name"
  | "all:no-date";

export interface ExistingEvent {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  status: string;
  sourceUrl: string | null;
}

export type FindDuplicateResult =
  | { isDuplicate: false; stagesSkipped: SkippedStage[] }
  | {
      isDuplicate: true;
      stagesSkipped: SkippedStage[];
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
      /** OPE-477 — set on `name_containment_date`: the tokens that matched. */
      sharedTokens?: string[];
    };

/**
 * OPE-432 — a merge tombstone is not a duplicate candidate.
 *
 * `merge_events` does not delete the losing row. It renames the slug to
 * `<orig>-merged-<id8>`, writes `event_slug_history`, sets `status='REJECTED'`
 * and `merged_into=<keeper>`, and leaves the row as an audit tombstone whose
 * only remaining job is to 301 to the keeper. It is a redirect, not an event.
 *
 * Returning one as a duplicate hands the submitter a URL that redirects away
 * from the row they were just told they duplicated. Reproduced live while
 * entering the missing 2028 Martha's Vineyard edition: `suggest_event` refused
 * it against a row whose slug was already
 * `marthas-vineyard-agricultural-fair-2026-merged-4acbfcb3`, and an operator
 * had to pass `force_create: true` to enter a legitimate event.
 *
 * Measured in prod 2026-08-18: 48 tombstones, 46 carrying a `source_url`
 * across 44 distinct URLs, 23 of them future-dated — i.e. inside the ±7d
 * window stages 2–4 match on.
 *
 * ── Why this keys on `merged_into` and NOT on `status='REJECTED'` ──
 *
 * The ticket asked for both. Excluding every REJECTED row would be a worse
 * defect than the one being fixed: OPE-278 exists to stop attendee-list and
 * list-broker spam from being classified `new_event` and creating events, and
 * the rows an operator rejects are exactly what that produces. Blind dedup to
 * them and previously-rejected spam becomes re-creatable on every resubmission,
 * with nothing left to match against.
 *
 * A REJECTED-but-not-merged row is also still a real record of a real
 * submission — unlike a tombstone, which by construction describes an event
 * that lives at a different id. So it stays matchable, and the thing that was
 * actually wrong about it (telling a submitter their event is "already in our
 * directory" when it was rejected) is fixed where the message is written; the
 * result already carries `status` for exactly that purpose.
 *
 * A status predicate here would also trip the OPE-437 guard in
 * `dedup-sees-nonpublic-events.test.ts`, which asserts this file applies no
 * status filter so dedup can keep seeing PENDING rows. That guard is right,
 * and `merged_into` is orthogonal to it.
 */
const notAMergeTombstone = () => isNull(events.mergedInto);

/**
 * OPE-432 — a deterministic winner when a window holds several live events.
 *
 * Every stage below is `limit(1)` over a set that routinely has more than one
 * row, and none of them ordered it, so which event a submitter was told they
 * duplicated depended on SQLite's scan order. That is the same defect class
 * OPE-454 fixed in stage 1 ("returned an ARBITRARY row"), still present in
 * stages 2–4. Prod holds 98 (venue, ±7d) windows containing more than one
 * candidate row, 49 of them future-dated.
 *
 * APPROVED first — a published event is the one a submitter can actually go
 * and look at, and the one whose URL is worth returning. `id` breaks the
 * remaining tie so repeated calls agree with each other.
 */
const bestMatchFirst = [
  sql`CASE WHEN ${events.status} = 'APPROVED' THEN 0 ELSE 1 END`,
  asc(events.id),
];

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

  // OPE-650 — stage 1 stops using a fixed window and asks the right question.
  //
  // Stage 1 used to reuse `dateWindowDays` (default 7). That window is a "the
  // organizer nudged the date" tolerance, which is right for venue+date
  // matching and WRONG here, because a weekly series is exactly 7 days apart —
  // so every consecutive pair lands on the inclusive boundary.
  //
  // Live case: Brookfield Orchards lists its whole season on one home page.
  // "The Kids Market" (Sep 19) and "Local Author's Fair" (Sep 26) are 7 days
  // apart, so `Sep 26 - 7 = Sep 19` matched, and the second event was refused
  // as an `exact_url` duplicate of the first. Different name, different date,
  // different event; the only thing shared was the URL.
  //
  // The semantics this stage already claims for itself (OPE-454, above) are
  // "same URL AND the dates agree ... This really is the same event." The right
  // test for that is not a window at all: it is whether the candidate day falls
  // inside the existing event's OWN RUN, `[start_date, end_date]`.
  //
  // That is what makes the two cases separable, and a symmetric window cannot:
  //
  //   a source reporting the fair's SECOND DAY   -> inside that event's run  -> same event
  //   the next weekly edition on the same page   -> outside it               -> a sibling
  //
  // A fixed ±N days has to choose between them and gets one wrong either way;
  // the event's own span already carries the answer.
  //
  // Nothing is lost. A genuine re-submission whose date moved outside the run
  // is still caught by stage 2 (venue+date, ±7d) or stage 4 (similar name +
  // date), both equally blocking. Stage 1 does not need to be the wide net.
  const urlDayStart = haveDate
    ? new Date(
        Date.UTC(
          eventDate.getUTCFullYear(),
          eventDate.getUTCMonth(),
          eventDate.getUTCDate(),
          0,
          0,
          0,
          0
        )
      )
    : null;
  // Day-bounded, so a noon-UTC-anchored row and a midnight-anchored one both
  // compare as the same calendar day rather than missing by twelve hours.
  const urlDayEnd = haveDate
    ? new Date(
        Date.UTC(
          eventDate.getUTCFullYear(),
          eventDate.getUTCMonth(),
          eventDate.getUTCDate(),
          23,
          59,
          59,
          999
        )
      )
    : null;

  // OPE-477 — every stage that could not evaluate, so "no match" is
  // distinguishable from "never checked".
  const stagesSkipped: SkippedStage[] = [];
  if (!input.sourceUrl) stagesSkipped.push("exact_url:no-source-url");
  if (!input.name) stagesSkipped.push("similar_name_date:no-name");
  if (!haveDate) stagesSkipped.push("all:no-date");

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
            // OPE-650 — does the candidate day fall inside this event's own run?
            // `end_date` is nullable, so a single-day event collapses to its
            // start and the test degrades to same-day, which is correct for it.
            lte(events.startDate, urlDayEnd!),
            // Raw fragment, so the bound value must be EPOCH SECONDS — Drizzle
            // only converts a Date for a typed column comparison, and these
            // columns are integer seconds.
            sql`COALESCE(${events.endDate}, ${events.startDate}) >= ${Math.floor(
              urlDayStart!.getTime() / 1000
            )}`,
            notAMergeTombstone()
          )
        )
        .orderBy(...bestMatchFirst)
        .limit(1);
      if (sameUrlAndDate.length > 0) {
        return {
          isDuplicate: true,
          stagesSkipped,
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
      .where(and(eq(events.sourceUrl, input.sourceUrl), notAMergeTombstone()))
      .orderBy(...bestMatchFirst)
      .limit(2);

    if (sameUrl.length > 0) {
      // An undated candidate against a URL that names exactly ONE event is
      // the original intent of this stage — a re-submission of the same
      // page with a date we failed to parse. Nothing contradicts it, so it
      // stays a blocking duplicate.
      const unambiguousUndated = !haveDate && sameUrl.length === 1;
      return {
        isDuplicate: true,
        stagesSkipped,
        matchType: unambiguousUndated ? "exact_url" : "series_url",
        identifiesSameEvent: unambiguousUndated,
        existingEvent: toExisting(sameUrl[0]),
      };
    }
  }

  // No startDate → no place/name matching is meaningful. Stages 2-4
  // all need a date window.
  if (!haveDate || minDate === null || maxDate === null) {
    return { isDuplicate: false, stagesSkipped };
  }
  // Re-bound as non-null for stages 2-4. `haveDate` is a plain boolean, so
  // TypeScript cannot narrow minDate/maxDate through it on its own.
  const windowStart: Date = minDate;
  const windowEnd: Date = maxDate;

  // ── Stages 2a + 2b: place + date ─────────────────────────────────
  const hasPlaceSignal = !!input.venueName || !!(input.venueCity && input.venueState);

  // OPE-477 — record inertness from the INPUTS, not from inside the block.
  // `hasPlaceSignal` can skip the whole of stage 2, so a push placed inside it
  // never runs in exactly the case this ticket is about: no venue name, no
  // city. (First attempt did that and the specimen test caught it.)
  if (!input.venueCity || !input.venueState) {
    stagesSkipped.push("city_state_date:no-city-state");
  }
  // `venue_date` is inert when there was nothing to resolve FROM. When there
  // was, the resolution result decides — recorded just after the attempt.
  if (!input.venueName) stagesSkipped.push("venue_date:venue-unresolved");

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
      // Attempted and came back empty — the stage cannot run.
      if (!resolvedVenueId) stagesSkipped.push("venue_date:venue-unresolved");
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
            lte(events.startDate, windowEnd),
            notAMergeTombstone()
          )
        )
        .orderBy(...bestMatchFirst)
        .limit(1);
      if (venueMatch.length > 0) {
        return {
          isDuplicate: true,
          stagesSkipped,
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
            lte(events.startDate, windowEnd),
            notAMergeTombstone()
          )
        )
        .orderBy(...bestMatchFirst)
        .limit(1);
      if (cityStateMatch.length > 0) {
        return {
          isDuplicate: true,
          stagesSkipped,
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
      .where(
        and(
          gte(events.startDate, windowStart),
          lte(events.startDate, windowEnd),
          notAMergeTombstone()
        )
      )
      .orderBy(...bestMatchFirst);
    for (const ev of similarEvents) {
      if (!ev.name) continue;
      const existingNormalized = normalizeName(ev.name);
      const sim = similarity(normalizedName, existingNormalized);
      if (sim > nameThreshold) {
        return {
          isDuplicate: true,
          stagesSkipped,
          matchType: "similar_name_date",
          identifiesSameEvent: true,
          similarity: sim,
          existingEvent: toExisting(ev),
        };
      }
    }
  }

  // ── Stage 4 (OPE-477): name containment, ONLY when both venue stages were blind ──
  //
  // The gate is the design, not a detail. Measured against the live corpus, this
  // signal applied broadly would add ~136 candidate pairs on top of the 223 the
  // venue stage already catches — enough to make `force_create: true` routine,
  // which is OPE-454's failure mode. Restricted to candidates whose venue
  // stages could not evaluate it touches 6 pairs corpus-wide.
  //
  // So a candidate that HAD a venue never reaches here, and matching for the
  // 42% of email submissions that resolve one is completely unchanged.
  const venueStagesWereBlind =
    stagesSkipped.includes("venue_date:venue-unresolved") &&
    stagesSkipped.includes("city_state_date:no-city-state");

  if (input.name && venueStagesWereBlind) {
    const normalizedName = normalizeName(input.name);
    const candidates = await db
      .select(eventColumns)
      .from(events)
      .where(
        and(
          gte(events.startDate, windowStart),
          lte(events.startDate, windowEnd),
          notAMergeTombstone()
        )
      )
      .orderBy(...bestMatchFirst);

    for (const ev of candidates) {
      if (!ev.name) continue;
      const match = nameContainmentMatch(normalizedName, normalizeName(ev.name));
      if (match) {
        return {
          isDuplicate: true,
          stagesSkipped,
          matchType: "name_containment_date",
          identifiesSameEvent: true,
          existingEvent: toExisting(ev),
          sharedTokens: match.sharedDistinctive,
        };
      }
    }
  }

  return { isDuplicate: false, stagesSkipped };
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
