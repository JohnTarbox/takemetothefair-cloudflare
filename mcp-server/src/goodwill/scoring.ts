/**
 * GW1c — Bayesian reliability updater.
 *
 * Fired by the admin `resolve_discrepancy` MCP tool (GW1d) on every
 * transition out of `resolution_status='open'`. Reads the discrepancy
 * row, decides which source(s) "won" the resolution, and updates
 * `source_reliability` for the relevant (source_key × field_class ×
 * axis) cells via Beta posterior arithmetic.
 *
 * ## Scoring math
 *
 * For each affected cell we accumulate two pseudo-counts:
 *   - alpha (successes) — observations where the source's value
 *     matched the resolved truth
 *   - beta  (failures)  — observations where it didn't
 *
 * The posterior mean is `alpha / (alpha + beta)`, which becomes the
 * stored `score`. Confidence buckets transition from `prior_only` →
 * `low` → `established` based on `n_checks`:
 *
 *   n_checks = 0   → 'prior_only'   (only the cold-start prior backs the cell)
 *   n_checks < 10  → 'low'          (some data but not enough to override the prior)
 *   n_checks >= 10 → 'established'  (the score is empirically grounded)
 *
 * ## Circularity guard (B8 + B9 of the dev email)
 *
 * The naive update rule has a self-reinforcing bug: when an OFFICIAL
 * (T1) source is also the authoritative source that won the
 * resolution, crediting it for "agreeing with itself" inflates its
 * score without new information. The guard:
 *
 *   if (resolutionSource === 'higher_tier' && authoritativeSourceKey
 *       matches the source that produced the resolution):
 *     skip the authoritative-side update; only update the divergent
 *     side's failure count.
 *
 * Practically: we always credit/debit the divergent side. We only
 * credit the authoritative side when the resolution came from
 * post-event verification or an operator's manual call — not when the
 * authoritative side WAS the higher tier that produced the truth.
 *
 * ## Initial row create
 *
 * Cells are created lazily. The first call for a (source_key,
 * field_class, axis) tuple reads the cold-start prior from
 * `source_type_priors` (joining via `sources.source_type`), then
 * inserts the source_reliability row at the prior values. Subsequent
 * calls update in place. If `sources` has no row for source_key, we
 * fall back to source_type='unknown' (the seed-priors INSERT
 * guarantees an `unknown` row for every field × axis cell).
 *
 * ## Model versioning
 *
 * `model_version` is read from MODEL_VERSION at update time. Bump
 * MODEL_VERSION in lock-step with a seed-priors change so historical
 * rows can be distinguished from rows scored under the new prior set.
 */

import { and, eq } from "drizzle-orm";
import { eventDiscrepancies, sourceReliability, sources, sourceTypePriors } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";

/** Bump in lock-step with seed-priors changes. */
export const MODEL_VERSION = "gw1-2026-06";

const ESTABLISHED_THRESHOLD = 10;

type Confidence = "prior_only" | "low" | "established";

/** Translate observation count to a confidence bucket. n=0 ⇒ only the
 *  cold-start prior; 1 ≤ n < ESTABLISHED_THRESHOLD ⇒ 'low'; otherwise
 *  'established'. */
function confidenceFromChecks(nChecks: number): Confidence {
  if (nChecks === 0) return "prior_only";
  if (nChecks < ESTABLISHED_THRESHOLD) return "low";
  return "established";
}

/** axis enum (mirrors the SQL column). */
type Axis = "accuracy" | "freshness";

/** field_class enum (mirrors the SQL column). */
type FieldClass = "date" | "hours" | "venue" | "status" | "price" | "existence" | "name";

type SourceTypeKey =
  | "official"
  | "dmo_tourism"
  | "ticketing"
  | "newspaper"
  | "social"
  | "aggregator"
  | "community"
  | "unknown";

interface UpdateReliabilityResult {
  decision:
    | "skipped_not_resolved"
    | "skipped_missing_discrepancy"
    | "skipped_no_source"
    | "skipped_db_error"
    | "updated";
  cellsTouched: number;
}

/**
 * Look up the source_type for a source_key. Falls back to 'unknown'
 * when the source isn't registered yet (which is fine — the seed
 * priors guarantee an 'unknown' bucket exists for every cell).
 */
async function lookupSourceType(db: Db, sourceKey: string): Promise<SourceTypeKey> {
  const rows = await db
    .select({ sourceType: sources.sourceType })
    .from(sources)
    .where(eq(sources.sourceKey, sourceKey))
    .limit(1);
  return (rows[0]?.sourceType as SourceTypeKey | undefined) ?? "unknown";
}

/**
 * Upsert one (source_key, field_class, axis) cell. Reads the existing
 * row (if any), adds the delta to alpha/beta, recomputes
 * score/confidence, and writes back. When no row exists yet, reads
 * the cold-start prior from source_type_priors and inserts.
 *
 * delta.alpha + delta.beta = 1 in the normal case (one observation
 * is one success OR one failure, not both).
 */
async function upsertCell(
  db: Db,
  args: {
    sourceKey: string;
    fieldClass: FieldClass;
    axis: Axis;
    deltaAlpha: number;
    deltaBeta: number;
  }
): Promise<void> {
  const existing = await db
    .select({
      alpha: sourceReliability.alpha,
      beta: sourceReliability.beta,
      nChecks: sourceReliability.nChecks,
      nAgreed: sourceReliability.nAgreed,
      nStale: sourceReliability.nStale,
    })
    .from(sourceReliability)
    .where(
      and(
        eq(sourceReliability.sourceKey, args.sourceKey),
        eq(sourceReliability.fieldClass, args.fieldClass),
        eq(sourceReliability.axis, args.axis)
      )
    )
    .limit(1);

  const sourceType = await lookupSourceType(db, args.sourceKey);
  let priorAlpha: number;
  let priorBeta: number;

  if (existing.length === 0) {
    // Cold-start: read priors for this (sourceType, fieldClass, axis).
    const priorRows = await db
      .select({
        priorAlpha: sourceTypePriors.priorAlpha,
        priorBeta: sourceTypePriors.priorBeta,
      })
      .from(sourceTypePriors)
      .where(
        and(
          eq(sourceTypePriors.sourceType, sourceType),
          eq(sourceTypePriors.fieldClass, args.fieldClass),
          eq(sourceTypePriors.axis, args.axis)
        )
      )
      .limit(1);
    priorAlpha = priorRows[0]?.priorAlpha ?? 5; // 50/50 fallback
    priorBeta = priorRows[0]?.priorBeta ?? 5;
  } else {
    // The row was created with priors already baked into alpha/beta;
    // we accumulate deltas on top.
    priorAlpha = existing[0].alpha;
    priorBeta = existing[0].beta;
  }

  const newAlpha = priorAlpha + args.deltaAlpha;
  const newBeta = priorBeta + args.deltaBeta;
  const newNChecks = (existing[0]?.nChecks ?? 0) + args.deltaAlpha + args.deltaBeta;
  const newNAgreed = (existing[0]?.nAgreed ?? 0) + args.deltaAlpha;
  const newNStale = existing[0]?.nStale ?? 0; // stale is incremented elsewhere by holdout sampling
  const newScore = newAlpha / (newAlpha + newBeta);
  const newConfidence = confidenceFromChecks(newNChecks);

  if (existing.length === 0) {
    await db.insert(sourceReliability).values({
      sourceKey: args.sourceKey,
      fieldClass: args.fieldClass,
      axis: args.axis,
      priorType: sourceType,
      alpha: newAlpha,
      beta: newBeta,
      nChecks: newNChecks,
      nAgreed: newNAgreed,
      nStale: newNStale,
      score: newScore,
      confidence: newConfidence,
      modelVersion: MODEL_VERSION,
      lastUpdated: new Date(),
    });
  } else {
    await db
      .update(sourceReliability)
      .set({
        alpha: newAlpha,
        beta: newBeta,
        nChecks: newNChecks,
        nAgreed: newNAgreed,
        score: newScore,
        confidence: newConfidence,
        modelVersion: MODEL_VERSION,
        lastUpdated: new Date(),
      })
      .where(
        and(
          eq(sourceReliability.sourceKey, args.sourceKey),
          eq(sourceReliability.fieldClass, args.fieldClass),
          eq(sourceReliability.axis, args.axis)
        )
      );
  }
}

/**
 * Score one resolved discrepancy. Decides who matched the resolved
 * value, applies the circularity guard, and upserts up to two cells
 * (one for each side's accuracy axis).
 *
 * Idempotency: callers must guard against double-firing this for the
 * same discrepancy id. The resolution_status='open' → non-open
 * transition is the natural single-shot trigger; GW1d's
 * resolve_discrepancy tool checks the prior status before updating.
 */
export async function updateReliability(
  db: Db,
  discrepancyId: string
): Promise<UpdateReliabilityResult> {
  try {
    const rows = await db
      .select()
      .from(eventDiscrepancies)
      .where(eq(eventDiscrepancies.id, discrepancyId))
      .limit(1);

    if (rows.length === 0) {
      return { decision: "skipped_missing_discrepancy", cellsTouched: 0 };
    }
    const disc = rows[0];

    if (disc.resolutionStatus === "open") {
      return { decision: "skipped_not_resolved", cellsTouched: 0 };
    }

    // Decide whether the authoritative side or the divergent side
    // matched the resolved value.
    const resolvedMatchesAuthoritative =
      disc.resolutionStatus === "resolved_authoritative" ||
      disc.resolutionStatus === "self_resolved";
    const resolvedMatchesDivergent = disc.resolutionStatus === "resolved_divergent";

    if (!resolvedMatchesAuthoritative && !resolvedMatchesDivergent) {
      // 'dismissed' status — no scoring signal (the discrepancy turned
      // out to be format-only or operator-misread).
      return { decision: "skipped_not_resolved", cellsTouched: 0 };
    }

    // Circularity guard: when resolution came from a HIGHER_TIER call
    // AND the authoritative source IS the higher-tier source, do NOT
    // credit the authoritative side. The "higher tier" trust is
    // exactly the source that produced the truth — crediting it for
    // matching itself is the self-reinforcing failure mode B8 calls
    // out.
    const skipAuthoritativeCredit =
      disc.resolutionSource === "higher_tier" && resolvedMatchesAuthoritative;

    let cellsTouched = 0;
    const fieldClass = disc.fieldClass as FieldClass;

    // Authoritative side update.
    if (disc.authoritativeSourceKey && !skipAuthoritativeCredit) {
      // The authoritative side either won (resolved_authoritative) or
      // lost (resolved_divergent). Score accuracy accordingly.
      await upsertCell(db, {
        sourceKey: disc.authoritativeSourceKey,
        fieldClass,
        axis: "accuracy",
        deltaAlpha: resolvedMatchesAuthoritative ? 1 : 0,
        deltaBeta: resolvedMatchesAuthoritative ? 0 : 1,
      });
      cellsTouched += 1;
    }

    // Divergent side update — always run; the circularity guard never
    // applies to this side because the divergent source by definition
    // isn't the source of truth.
    if (disc.divergentSourceKey) {
      await upsertCell(db, {
        sourceKey: disc.divergentSourceKey,
        fieldClass,
        axis: "accuracy",
        deltaAlpha: resolvedMatchesDivergent ? 1 : 0,
        deltaBeta: resolvedMatchesDivergent ? 0 : 1,
      });
      cellsTouched += 1;
    }

    if (cellsTouched === 0) {
      return { decision: "skipped_no_source", cellsTouched: 0 };
    }
    return { decision: "updated", cellsTouched };
  } catch (err) {
    await logError(db, {
      source: "mcp:goodwill:scoring",
      message: `updateReliability failed for discrepancy=${discrepancyId}`,
      error: err,
    });
    return { decision: "skipped_db_error", cellsTouched: 0 };
  }
}

/** Exported for tests + GW1e report-card. */
export { confidenceFromChecks };
/** Exported for tests — they may want to drive cell init directly. */
export { upsertCell as upsertSourceReliabilityCell };
