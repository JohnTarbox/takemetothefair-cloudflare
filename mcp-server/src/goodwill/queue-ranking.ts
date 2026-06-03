/**
 * GW1d outreach-queue ranker.
 *
 * Computes `outreach_priority_score` for an `event_discrepancies` row
 * so the admin queue (list_event_discrepancies sorted DESC) surfaces
 * the highest-leverage candidates first.
 *
 * ## Formula (per the dev email)
 *
 *   score = 0.3 × event_view_count_normalized
 *         + 0.3 × (1 − source_reliability_score)
 *         + 0.2 × detector_confidence
 *         + 0.1 × recency_decay
 *         + 0.1 × field_severity
 *
 * Each term is normalized to [0, 1] so the weighted sum lands in the
 * same range. The weights are written here explicitly so the CPI loop
 * (GW1e) can tune them without code change — exported as
 * QUEUE_RANK_WEIGHTS for any future config-driven path.
 *
 * ## field_severity bucket
 *
 *   date | venue | name        = 1.0  (highest-stakes — wrong dates
 *                                       break the value prop)
 *   hours | price               = 0.6  (consequential but recoverable)
 *   existence | status          = 0.4  (informational — the event row
 *                                       itself may be the issue)
 *
 * ## recency_decay
 *
 *   Linear decay over 180 days. detected_at within 1 day = 1.0,
 *   180+ days ago = 0.0. Keeps stale discrepancies from dominating
 *   the queue forever.
 *
 * ## event_view_count_normalized
 *
 *   log10(view_count + 1) / log10(MAX_VIEW_COUNT_CAP + 1) clamped to
 *   [0, 1]. Log scale because view counts are heavy-tailed in this
 *   corpus — a top-1% event has 100× the views of median. Without
 *   the log, the queue would never surface anything but the top
 *   handful of events.
 *
 * ## Why not a stored procedure
 *
 * Same reason most of the goodwill module avoids them — Cloudflare D1
 * doesn't run stored procs. The ranker runs in JS at write time
 * (capture path) or batched (the optional GW1d backfill helper at the
 * bottom). Cheap either way.
 */

import { and, eq, sql } from "drizzle-orm";
import { eventDiscrepancies, sourceReliability, events } from "../schema.js";
import type { Db } from "../db.js";

export const QUEUE_RANK_WEIGHTS = {
  viewCount: 0.3,
  unreliable: 0.3,
  detectorConfidence: 0.2,
  recency: 0.1,
  fieldSeverity: 0.1,
} as const;

const FIELD_SEVERITY: Record<string, number> = {
  date: 1.0,
  venue: 1.0,
  name: 1.0,
  hours: 0.6,
  price: 0.6,
  existence: 0.4,
  status: 0.4,
};

const RECENCY_DECAY_DAYS = 180;
const MAX_VIEW_COUNT_CAP = 10_000; // anchor for the log-scale denominator

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function recencyDecay(detectedAt: Date | null | undefined): number {
  if (!detectedAt) return 0;
  const ageDays = (Date.now() - detectedAt.getTime()) / (24 * 60 * 60 * 1000);
  return clamp01(1 - ageDays / RECENCY_DECAY_DAYS);
}

function viewCountNormalized(viewCount: number | null | undefined): number {
  const raw = Math.max(0, viewCount ?? 0);
  const num = Math.log10(raw + 1);
  const denom = Math.log10(MAX_VIEW_COUNT_CAP + 1);
  return clamp01(num / denom);
}

function fieldSeverity(fieldClass: string | null | undefined): number {
  if (!fieldClass) return 0.5;
  return FIELD_SEVERITY[fieldClass] ?? 0.5;
}

export interface RankInputs {
  viewCount: number | null | undefined;
  divergentSourceReliability: number | null | undefined; // 0..1 score; null ⇒ unknown
  detectorConfidence: number | null | undefined;
  detectedAt: Date | null | undefined;
  fieldClass: string | null | undefined;
}

/**
 * Compute the queue-rank score from primitive inputs. Pure function;
 * the I/O is the caller's responsibility (so the same ranker can run
 * synchronously inside the capture helper or batched offline).
 */
export function computeOutreachPriorityScore(inputs: RankInputs): number {
  const unreliable = clamp01(1 - (inputs.divergentSourceReliability ?? 0.5));
  const detectorConf = clamp01(inputs.detectorConfidence ?? 0.5);
  const score =
    QUEUE_RANK_WEIGHTS.viewCount * viewCountNormalized(inputs.viewCount) +
    QUEUE_RANK_WEIGHTS.unreliable * unreliable +
    QUEUE_RANK_WEIGHTS.detectorConfidence * detectorConf +
    QUEUE_RANK_WEIGHTS.recency * recencyDecay(inputs.detectedAt) +
    QUEUE_RANK_WEIGHTS.fieldSeverity * fieldSeverity(inputs.fieldClass);
  return clamp01(score);
}

/**
 * Batched re-rank for the open queue. Joins event_discrepancies →
 * events (for view_count) → source_reliability (for the divergent
 * source's accuracy score) and writes the computed score back into
 * `event_discrepancies.outreach_priority_score`. Caller chooses the
 * batch size — the function processes one batch end-to-end.
 *
 * Use cases:
 *   - GW1d backfill on the open queue once when the formula lands
 *   - Daily refresh from the GW1e cron when view counts have moved
 *     materially (deferred until view counts stabilize)
 */
export interface RerankResult {
  scanned: number;
  updated: number;
  outreach_candidates: number; // rows above the outreach threshold (>= 0.6)
}

const OUTREACH_CANDIDATE_THRESHOLD = 0.6;

export async function rerankOpenQueueBatch(
  db: Db,
  opts: { limit?: number } = {}
): Promise<RerankResult> {
  const limit = opts.limit ?? 200;
  const result: RerankResult = { scanned: 0, updated: 0, outreach_candidates: 0 };

  const rows = await db
    .select({
      id: eventDiscrepancies.id,
      fieldClass: eventDiscrepancies.fieldClass,
      detectedAt: eventDiscrepancies.detectedAt,
      confidence: eventDiscrepancies.confidence,
      divergentSourceKey: eventDiscrepancies.divergentSourceKey,
      eventId: eventDiscrepancies.eventId,
      viewCount: events.viewCount,
    })
    .from(eventDiscrepancies)
    .innerJoin(events, eq(eventDiscrepancies.eventId, events.id))
    .where(
      and(
        eq(eventDiscrepancies.resolutionStatus, "open"),
        // Only re-rank rows that don't already have a score, OR rows
        // older than 1 day (so daily refresh picks them up).
        sql`(
          ${eventDiscrepancies.outreachPriorityScore} IS NULL
          OR ${eventDiscrepancies.detectedAt} < unixepoch() - 86400
        )`
      )
    )
    .limit(limit);

  result.scanned = rows.length;

  // Batch-resolve the divergent-source reliability scores for the
  // (source_key, field_class, axis='accuracy') tuples we need.
  for (const row of rows) {
    let divergentScore: number | null = null;
    if (row.divergentSourceKey) {
      const reliabilityRow = await db
        .select({ score: sourceReliability.score })
        .from(sourceReliability)
        .where(
          and(
            eq(sourceReliability.sourceKey, row.divergentSourceKey),
            eq(sourceReliability.fieldClass, row.fieldClass),
            eq(sourceReliability.axis, "accuracy")
          )
        )
        .limit(1);
      divergentScore = reliabilityRow[0]?.score ?? null;
    }

    const score = computeOutreachPriorityScore({
      viewCount: row.viewCount,
      divergentSourceReliability: divergentScore,
      detectorConfidence: row.confidence,
      detectedAt: row.detectedAt,
      fieldClass: row.fieldClass,
    });
    const isCandidate = score >= OUTREACH_CANDIDATE_THRESHOLD;

    await db
      .update(eventDiscrepancies)
      .set({
        outreachPriorityScore: score,
        outreachCandidate: isCandidate,
      })
      .where(eq(eventDiscrepancies.id, row.id));

    result.updated += 1;
    if (isCandidate) result.outreach_candidates += 1;
  }

  return result;
}
