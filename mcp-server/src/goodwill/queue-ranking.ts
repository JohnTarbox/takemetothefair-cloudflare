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
 * OPE-245 — the write-time initial score, shared by every capture path
 * (`captureDiscrepancy` for the automated detectors + the manual
 * `create_discrepancy` MCP tool) so a discrepancy is NEVER inserted with a
 * NULL score again. That NULL-on-insert was the whole bug: `captureDiscrepancy`
 * set `outreachCandidate: false` and omitted the score, so all 6,121 open rows
 * were unranked from ship.
 *
 * Uses neutral priors for the two inputs that need a DB read — `viewCount`
 * (from `events`) and `divergentSourceReliability` (from `source_reliability`)
 * — so the capture path stays a single INSERT with no extra round-trips on a
 * hot cron path. The batched `rerankOpenQueueBatch` later upgrades the score
 * with the real view count (a null-prior score can't cross the 0.6 candidate
 * threshold on its own, by design — a discrepancy only becomes an outreach
 * candidate once its event's traffic is factored in).
 */
export function initialCaptureScore(args: {
  fieldClass: string | null | undefined;
  confidence: number | null | undefined;
  detectedAt: Date;
}): number {
  return computeOutreachPriorityScore({
    viewCount: null, // upgraded by rerankOpenQueueBatch
    divergentSourceReliability: null, // neutral prior until the learner has data
    detectorConfidence: args.confidence,
    detectedAt: args.detectedAt,
    fieldClass: args.fieldClass,
  });
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
  opts: { limit?: number; onlyMissing?: boolean } = {}
): Promise<RerankResult> {
  const limit = opts.limit ?? 200;
  const result: RerankResult = { scanned: 0, updated: 0, outreach_candidates: 0 };

  // `onlyMissing` (OPE-245): score ONLY rows that lack a score. Used by the
  // daily safety-net cron so it's a bounded catch-up (≈0 rows once write-time
  // scoring is live), not a re-rank of the whole queue every night. The default
  // (null-score OR detected >24h ago) is kept for the manual backfill/refresh
  // via the rerank_outreach_queue tool.
  const selection = opts.onlyMissing
    ? sql`${eventDiscrepancies.outreachPriorityScore} IS NULL`
    : sql`(
        ${eventDiscrepancies.outreachPriorityScore} IS NULL
        OR ${eventDiscrepancies.detectedAt} < unixepoch() - 86400
      )`;

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
    .where(and(eq(eventDiscrepancies.resolutionStatus, "open"), selection))
    // OPE-245: unscored rows first, so a bounded pass always makes progress on
    // the actual gap before spending its budget re-refreshing scored rows.
    .orderBy(sql`${eventDiscrepancies.outreachPriorityScore} IS NULL DESC`)
    .limit(limit);

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // OPE-245: preload the (accuracy-axis) source_reliability table into a Map
  // instead of one SELECT per row. The table is tiny (1 row at time of writing)
  // and the divergent-source key set per batch is small, so a single read
  // replaces up to `limit` reads — the N+1 that made a 500-row backfill risk
  // the Worker subrequest budget. Key = `${sourceKey}::${fieldClass}`.
  const reliabilityByKey = new Map<string, number>();
  const allReliability = await db
    .select({
      sourceKey: sourceReliability.sourceKey,
      fieldClass: sourceReliability.fieldClass,
      score: sourceReliability.score,
    })
    .from(sourceReliability)
    .where(eq(sourceReliability.axis, "accuracy"));
  for (const r of allReliability) {
    if (r.score != null) reliabilityByKey.set(`${r.sourceKey}::${r.fieldClass}`, r.score);
  }

  for (const row of rows) {
    const divergentScore =
      row.divergentSourceKey != null
        ? (reliabilityByKey.get(`${row.divergentSourceKey}::${row.fieldClass}`) ?? null)
        : null;

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

/**
 * OPE-245 — daily maintenance: score any open discrepancy that slipped through
 * write-time scoring. Loops bounded `onlyMissing` batches so a future capture
 * path that forgets to score can't silently reintroduce the all-NULL queue.
 *
 * Deliberately NOT a full view-count refresh — the GW1d spec defers that until
 * view counts stabilize. This is a safety net: once every capture path scores
 * at write time, it processes ≈0 rows/night. Bounded by `maxBatches` so it
 * can't run away on a bad day. Failsoft: the daily cron caller wraps this and a
 * throw here would abort its Promise.all siblings.
 */
export async function runScheduledQueueRerank(
  db: Db,
  opts: { batchSize?: number; maxBatches?: number } = {}
): Promise<RerankResult> {
  const batchSize = opts.batchSize ?? 200;
  const maxBatches = opts.maxBatches ?? 5;
  const total: RerankResult = { scanned: 0, updated: 0, outreach_candidates: 0 };
  for (let i = 0; i < maxBatches; i++) {
    const batch = await rerankOpenQueueBatch(db, { limit: batchSize, onlyMissing: true });
    total.scanned += batch.scanned;
    total.updated += batch.updated;
    total.outreach_candidates += batch.outreach_candidates;
    if (batch.updated === 0) break; // drained
  }
  return total;
}
