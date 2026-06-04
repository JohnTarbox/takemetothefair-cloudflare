/**
 * GW1.2 (2026-06-03) — Reliability-weighted resolution at ingest.
 *
 * When the GW1.1 comparator surfaces a field disagreement between a new
 * submission and an existing event, this module asks: "which source
 * should we believe?" — by consulting the per-source posterior score
 * in `source_reliability` (Bayesian Beta posterior maintained by
 * GW1c), and picking the value to keep by reliability-weighted vote
 * rather than submission-order or hardcoded source hierarchy.
 *
 * ## Decision shape
 *
 *   - Look up both sources' `(source_key, field_class, axis='accuracy')`
 *     row in source_reliability.
 *   - Below the configured margin (default 0.2 absolute) → keep the
 *     existing stored value, log the decision in the discrepancy
 *     notes. The discrepancy is still emitted (GW1.1's path) so the
 *     data is captured.
 *   - At or above the margin AND winner is the candidate → flip the
 *     stored value (events.<column> + new K4 citation row), log
 *     "flipped" outcome in the discrepancy notes.
 *   - At or above the margin AND winner is the existing value → no
 *     flip (existing already wins), log "existing_won_by_margin".
 *   - If EITHER side has no reliability row (unknown source) → no
 *     flip (we can't compare), log "unknown_source".
 *
 * ## Why 0.2 absolute
 *
 * The spec calls for 0.2 as a "start with this and let CPI tune"
 * value. Hardcoded as a constant for V1; the spec author flagged
 * placement of this threshold as needing a separate decision tied
 * to GW1.4's authority-override threshold ("config value belongs in
 * the same place" per the 2026-06-03 dev backlog). When GW1.4's
 * config store lands, move BOTH thresholds together — they're the
 * same semantic dial.
 *
 * Filed as TODO at use sites + commit message. Until then, changes
 * require a deploy.
 *
 * ## Feature-flag gate
 *
 * Per safe-rollout convention: this module ALWAYS does the decision
 * + emits the discrepancy, but only actually flips the stored value
 * when the env var `GOODWILL_FLIP_ENABLED='1'` is set. Default behavior
 * is shadow-mode (decisions logged in notes, no events.* writes) so
 * the first week of production traffic surfaces what WOULD have
 * flipped without committing to data changes. John enables the flag
 * after observing a clean shadow window.
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { sourceReliability } from "@/lib/db/schema";
import type { IngestFieldClass } from "@/lib/goodwill/ingest-discrepancy";

/** Margin gate from the spec. Move to a config table when GW1.4 ships. */
export const RELIABILITY_FLIP_MARGIN = 0.2;

/** Subset of FieldClass we can resolve at ingest. `hours`/`status`/
 *  `price`/`existence` aren't surfaced by the GW1.1 comparator today
 *  (those come from different capture paths). Restating the union here
 *  keeps the resolver's contract clean and the wire type stable when
 *  the comparator grows new fields. */
export type ResolvableFieldClass = IngestFieldClass;

export interface ReliabilityRow {
  score: number;
  /** "prior_only" | "low" | "established" — we don't gate on this here
   *  (the score itself carries the same signal via posterior width),
   *  but surface it so callers can log it for audit. */
  confidence: string;
  nChecks: number;
}

export interface ResolutionInput {
  fieldClass: ResolvableFieldClass;
  candidateSourceKey: string | null;
  existingSourceKey: string | null;
}

export interface ResolutionResult {
  /** "candidate" when the new submission's source has higher reliability
   *  by at least the margin; "existing" when the existing event's
   *  source does; null when we can't decide (margin too small, or
   *  either source is unknown to the index). */
  winner: "candidate" | "existing" | null;
  /** Reason code logged in discrepancy notes for downstream audit:
   *  - `flipped`          — winner=candidate, margin met, flip enabled
   *  - `would_flip`       — winner=candidate, margin met, flip disabled (shadow)
   *  - `existing_won`     — winner=existing, no flip needed
   *  - `below_margin`     — both sides scored, but |c-e| < margin
   *  - `unknown_source`   — one or both sources lack a reliability row
   */
  reason: "flipped" | "would_flip" | "existing_won" | "below_margin" | "unknown_source";
  /** Raw scores for the audit trail (null when not looked up). */
  candidateScore: number | null;
  existingScore: number | null;
  /** Absolute score gap; null when either side is unknown. */
  marginAbs: number | null;
}

/**
 * Look up the `(source_key, field_class, axis='accuracy')` row in
 * source_reliability. Returns null when no row exists OR when the
 * source_key is empty/null.
 *
 * Axis is hardcoded to 'accuracy' here. The 'freshness' axis is a
 * separate dial maintained by the same scorer but used for different
 * decisions (sitemap submission priority, recommendation rank). Ingest
 * resolution is purely an accuracy question.
 */
export async function lookupReliability(
  db: Database,
  sourceKey: string | null,
  fieldClass: ResolvableFieldClass
): Promise<ReliabilityRow | null> {
  if (!sourceKey) return null;
  const rows = await db
    .select({
      score: sourceReliability.score,
      confidence: sourceReliability.confidence,
      nChecks: sourceReliability.nChecks,
    })
    .from(sourceReliability)
    .where(
      and(
        eq(sourceReliability.sourceKey, sourceKey),
        eq(sourceReliability.fieldClass, fieldClass),
        eq(sourceReliability.axis, "accuracy")
      )
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0];
}

/**
 * Apply the reliability-weighted decision rule. Pure — no I/O — so it's
 * unit-testable against scores you supply directly. The caller (route
 * layer) handles the DB lookups and the flip-write.
 *
 * `flipEnabled` is the env-var gate (`GOODWILL_FLIP_ENABLED='1'`). When
 * false, a winner=candidate above-margin result returns reason='would_
 * flip' instead of 'flipped' — the caller skips the write but still
 * logs the decision in the discrepancy notes.
 */
export function decideResolution(
  input: ResolutionInput & {
    candidateScore: number | null;
    existingScore: number | null;
    flipEnabled: boolean;
    margin?: number;
  }
): ResolutionResult {
  const margin = input.margin ?? RELIABILITY_FLIP_MARGIN;

  if (input.candidateScore === null || input.existingScore === null) {
    return {
      winner: null,
      reason: "unknown_source",
      candidateScore: input.candidateScore,
      existingScore: input.existingScore,
      marginAbs: null,
    };
  }

  const gap = input.candidateScore - input.existingScore;
  const absGap = Math.abs(gap);

  if (absGap < margin) {
    return {
      winner: null,
      reason: "below_margin",
      candidateScore: input.candidateScore,
      existingScore: input.existingScore,
      marginAbs: absGap,
    };
  }

  if (gap > 0) {
    // Candidate has the higher score — flip if enabled.
    return {
      winner: "candidate",
      reason: input.flipEnabled ? "flipped" : "would_flip",
      candidateScore: input.candidateScore,
      existingScore: input.existingScore,
      marginAbs: absGap,
    };
  }

  // Existing has the higher score (gap < 0, and we already ruled out
  // |gap| < margin). No flip needed — existing already won.
  return {
    winner: "existing",
    reason: "existing_won",
    candidateScore: input.candidateScore,
    existingScore: input.existingScore,
    marginAbs: absGap,
  };
}

/**
 * Format the decision as a notes-suffix string that augments the GW1.1
 * discrepancy notes for human + scorer-aware audit. Examples:
 *
 *   " [gw1.2 flipped: c=0.91 vs e=0.61]"
 *   " [gw1.2 would_flip: c=0.91 vs e=0.61]"  (shadow mode)
 *   " [gw1.2 existing_won: c=0.55 vs e=0.85]"
 *   " [gw1.2 below_margin: c=0.81 vs e=0.79]"
 *   " [gw1.2 unknown_source: candidate=null]"
 */
export function formatResolutionNotes(result: ResolutionResult): string {
  const c = result.candidateScore === null ? "null" : result.candidateScore.toFixed(2);
  const e = result.existingScore === null ? "null" : result.existingScore.toFixed(2);
  return ` [gw1.2 ${result.reason}: c=${c} vs e=${e}]`;
}
