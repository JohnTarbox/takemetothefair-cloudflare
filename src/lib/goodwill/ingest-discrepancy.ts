/**
 * GW1.1 (2026-06-03) — Ingest-path discrepancy comparator.
 *
 * When `findDuplicate` returns a stages-2-4 match for a new submission,
 * we suspect the two sources describe the same event. This comparator
 * decides — per the spec's "richer comparison" path — WHICH fields the
 * two sources disagree about, so the goodwill engine can score per-
 * field reliability rather than treating every dedup hit as one big
 * indistinguishable signal.
 *
 * The comparator is pure: it takes the candidate's claim and the
 * existing event's full row, and returns one descriptor per
 * disagreeing field. The route layer then enqueues each descriptor
 * onto EVENT_DISCREPANCIES; the MCP consumer writes them as
 * `event_discrepancies` rows with `detected_by='ingest_addverify'`.
 *
 * Per-stage logic (what CAN disagree, given the stage's match constraints):
 *
 *   - `exact_url` → nothing. Same source URL means same source; the
 *     route never calls this comparator on stage 1 matches.
 *   - `venue_date` → `date` (within-window dates can still differ
 *     exactly) and/or `name` (no name gate in stage 2). Venue agrees
 *     by definition (same venueId).
 *   - `city_state_date` → `date` and/or `name`, plus `venue` if the
 *     two events resolved to different venueIds despite shared
 *     city/state (the case Winthrop exposed: two venue rows for the
 *     same place).
 *   - `similar_name_date` → `date` and/or `venue` (city/state OR
 *     venueId differs). Name agrees by definition (sim > 0.85).
 *
 * Notes on what we DON'T compare:
 *
 *   - `end_date` — the candidate input shape (`checkDuplicateSchema`
 *     in the route) doesn't carry an `endDate` field today. When that
 *     gets added, this comparator's `date` arm should extend to fire
 *     on either end. The `field_class='date'` row already covers it
 *     semantically.
 *   - venue resolution via `autoLinkVenue` — the comparator doesn't
 *     re-resolve the candidate's venue strings to a venueId. We
 *     compare `(city, state)` strings as a proxy. For stage 4 matches
 *     where city/state happen to agree but the candidate's venueName
 *     points to a different venue row, we miss that disagreement. Net
 *     ok: false negative rather than false positive.
 *
 * Confidence is fixed at 0.85 — the dedup match itself is strong
 * evidence the events are the same, so the field disagreement is
 * likely a real source conflict rather than a wrong-event match.
 * Tuned by CPI down the line.
 */

import type { MatchType } from "@/lib/duplicates/find-duplicate";
import { normalizeName } from "@/lib/duplicates/normalize-name";
import { similarity } from "@/lib/duplicates/find-duplicate";

/** Same as the queue message shape's fieldClass — restated here so the
 *  comparator's contract reads independently of the wire shape. */
export type IngestFieldClass = "date" | "venue" | "name";

/** The new submission's claim, as it arrived at the route. Mirrors the
 *  fields the existing `/api/suggest-event/check-duplicate` route already
 *  accepts (`checkDuplicateSchema`). Strings, no DB types. */
export interface IngestCandidate {
  name?: string | null;
  /** YYYY-MM-DD (or any Date-parseable). The schema doesn't carry an
   *  endDate today; comparator is shape-ready for when it does. */
  startDate?: string | null;
  endDate?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
  /** Optional pre-resolved venueId, when the caller has already run
   *  `autoLinkVenue` (it usually hasn't). Reserved; today's route
   *  leaves this undefined and we fall back to city/state comparison. */
  venueId?: string | null;
  /** Original-source URL of the new submission. The divergent
   *  source_url for every emitted row. */
  sourceUrl: string;
}

/** The existing event row, re-fetched in the route after the
 *  findDuplicate match (the slim `ExistingEvent` returned by
 *  findDuplicate is missing endDate/venueId/venueCity/venueState/
 *  sourceDomain — see find-duplicate.ts:62-69). */
export interface IngestExistingEvent {
  id: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  venueId: string | null;
  /** From the venues join — NULL when the event has no venue. */
  venueCity: string | null;
  venueState: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
}

/** One disagreement detected by the comparator. Shape matches the
 *  queue message's authoritative/divergent halves directly so the
 *  route's emit loop is a 1:1 mapping. */
export interface IngestDiscrepancy {
  fieldClass: IngestFieldClass;
  /** What the existing event's stored value is. NULL for fields where
   *  the existing event has no value (e.g. a date discrepancy where
   *  existing.startDate is NULL — shouldn't happen on stages 2-4
   *  since the date gate requires the existing row to have a date,
   *  but the type permits it for defensiveness). */
  authoritativeValue: string | null;
  /** What the new submission claims. */
  divergentValue: string | null;
  /** Short audit string; ends up in `event_discrepancies.notes`. */
  notes: string;
}

/** Levenshtein similarity threshold for `name` field equality. Mirrors
 *  the one used by findDuplicate's stage 4 — keeping the two thresholds
 *  in sync avoids a discrepancy "name differs by 0.86 here vs 0.85
 *  there" boundary case. */
const NAME_SIM_THRESHOLD = 0.85;

/**
 * Compute the disagreements between the new submission's claim and the
 * existing event the dedup matched. Pure — no I/O, no clock reads.
 *
 * Returns an empty array on no disagreement (sources concur). Returns
 * an empty array on `matchType === 'exact_url'` (same source by
 * definition; the route shouldn't call this for stage 1, but be safe).
 */
export function compareForIngest(
  matchType: MatchType,
  candidate: IngestCandidate,
  existing: IngestExistingEvent
): IngestDiscrepancy[] {
  if (matchType === "exact_url") return [];

  const out: IngestDiscrepancy[] = [];

  // ── date ────────────────────────────────────────────────────────
  // Always compared on stages 2/3/4. The dedup match's ±7-day window
  // means the dates are within range, not equal. We emit when start
  // dates differ exactly (and someday, when end dates do too).
  const candStart = isoOrNull(candidate.startDate);
  const existStart = existing.startDate ? toIsoDate(existing.startDate) : null;
  if (candStart && existStart && candStart !== existStart) {
    out.push({
      fieldClass: "date",
      authoritativeValue: existStart,
      divergentValue: candStart,
      notes: `${matchType}: start_date differs (${existStart} vs ${candStart})`,
    });
  }

  // ── venue ───────────────────────────────────────────────────────
  // Stage 2 matched by venueId — never a venue disagreement.
  // Stage 3 matched by city+state — venueIds CAN still differ (two
  //   venue rows for the same place; the Winthrop case).
  // Stage 4 matched by name only — both venueId and city/state CAN
  //   differ.
  if (matchType === "city_state_date" || matchType === "similar_name_date") {
    const venueNote = describeVenueDisagreement(matchType, candidate, existing);
    if (venueNote) {
      out.push({
        fieldClass: "venue",
        authoritativeValue: venueNote.authoritative,
        divergentValue: venueNote.divergent,
        notes: venueNote.notes,
      });
    }
  }

  // ── name ────────────────────────────────────────────────────────
  // Stage 4 matched on name similarity > 0.85 — never a name
  // disagreement. Stages 2 and 3 have no name gate, so emit when
  // normalized names fall under the same threshold.
  if (matchType === "venue_date" || matchType === "city_state_date") {
    if (candidate.name && existing.name) {
      const sim = similarity(normalizeName(candidate.name), normalizeName(existing.name));
      if (sim <= NAME_SIM_THRESHOLD) {
        out.push({
          fieldClass: "name",
          authoritativeValue: existing.name,
          divergentValue: candidate.name,
          notes: `${matchType}: name differs (sim=${sim.toFixed(2)})`,
        });
      }
    }
  }

  return out;
}

function describeVenueDisagreement(
  matchType: Extract<MatchType, "city_state_date" | "similar_name_date">,
  candidate: IngestCandidate,
  existing: IngestExistingEvent
): { authoritative: string | null; divergent: string | null; notes: string } | null {
  // Stage 3 (city_state_date) matched on city+state, so the only
  // venue disagreement possible is venueId. If the candidate didn't
  // pre-resolve a venueId (typical case today), we have nothing to
  // compare and skip. Forward-compatible: when callers start passing
  // resolved venueIds, this fires.
  if (matchType === "city_state_date") {
    if (!candidate.venueId || !existing.venueId) return null;
    if (candidate.venueId === existing.venueId) return null;
    return {
      authoritative: existing.venueId,
      divergent: candidate.venueId,
      notes: `city_state_date: venue_id differs (two venue rows for same place?)`,
    };
  }

  // Stage 4 (similar_name_date) — compare city+state strings (lossy
  // but useful) and venueId if both sides have one. Pick whichever
  // comparison produces a difference and report it as the venue
  // disagreement.
  const candCity = trimOrNull(candidate.venueCity);
  const candState = trimOrNull(candidate.venueState)?.toUpperCase() ?? null;
  const existCity = trimOrNull(existing.venueCity);
  const existState = existing.venueState ?? null;
  const candKey = candCity && candState ? `${candCity}, ${candState}` : null;
  const existKey = existCity && existState ? `${existCity}, ${existState}` : null;

  // Venue strings differ? — emit that.
  if (candKey && existKey && candKey.toLowerCase() !== existKey.toLowerCase()) {
    return {
      authoritative: existKey,
      divergent: candKey,
      notes: `similar_name_date: venue location differs (${existKey} vs ${candKey})`,
    };
  }

  // Locations agree but venueIds differ? — emit that (Winthrop case
  // surfaces here too if both sides happen to be filled).
  if (candidate.venueId && existing.venueId && candidate.venueId !== existing.venueId) {
    return {
      authoritative: existing.venueId,
      divergent: candidate.venueId,
      notes: `similar_name_date: venue_id differs despite matching location`,
    };
  }

  return null;
}

function isoOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  // Already YYYY-MM-DD? — accept directly so we don't accidentally
  // shift by timezone in `new Date()`.
  const direct = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (direct) return direct[0];
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return toIsoDate(d);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function trimOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}
