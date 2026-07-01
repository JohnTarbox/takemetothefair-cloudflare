// Promoter pre-extraction candidate selector (OPE-36) — the promoter analog
// of select-candidates.ts. The nightly cron picks ≤50 promoters that have a
// website and still NEED_ENRICHMENT (or were never assessed), enqueues one job
// each, and lets the queue consumer do the fetch + extract + stage/auto-apply.
//
// Never-attempted first, then stale (>30d). Field-blank-based selection isn't
// needed here: computePromoterEnrichment already folds "website present + a
// target field empty" into enrichment_status='NEEDS_ENRICHMENT' at write time,
// so the status gate IS the field gate.
import { sql } from "drizzle-orm";
import { promoters } from "../schema.js";
import { getDb } from "../db.js";
import { logError } from "../logger.js";
import type { PromoterEnrichmentMessage } from "./promoter-dispatch.js";

/** ≤50/night — slower-is-safer on the first sweep. */
const NIGHTLY_LIMIT = 50;
/** Re-attempt a promoter at most once per 30 days. */
const REATTEMPT_DAYS = 30;

export interface PromoterSelectorEnv {
  DB: D1Database;
  PROMOTER_ENRICHMENT?: Queue<PromoterEnrichmentMessage>;
  /** Operator switch — "false" flips off the dry-run default (enables auto-apply). */
  ENRICHMENT_DRY_RUN?: string;
}

export interface PromoterSelectionResult {
  jobRunId: string;
  enqueued: number;
  dryRun: boolean;
}

/**
 * Cron entrypoint. Idempotent enough to re-run: the 30-day attempt window +
 * the dispatcher's clear-and-restage keep duplicates from piling up. jobRunId
 * is supplied by the caller (scheduled handler) to keep this free of ambient
 * randomness for unit testing.
 */
export async function runScheduledPromoterEnrichment(
  env: PromoterSelectorEnv,
  jobRunId: string,
  nowMs: number
): Promise<PromoterSelectionResult> {
  const db = getDb(env.DB);
  const dryRun = env.ENRICHMENT_DRY_RUN !== "false";
  const staleCutoff = Math.floor((nowMs - REATTEMPT_DAYS * 86_400_000) / 1000);

  const rows = await db
    .select({ id: promoters.id })
    .from(promoters)
    .where(
      sql`${promoters.website} IS NOT NULL AND TRIM(${promoters.website}) <> ''
        AND (
          ${promoters.enrichmentStatus} IS NULL
          OR ${promoters.enrichmentStatus} = 'NEEDS_ENRICHMENT'
        )
        AND (
          ${promoters.enrichmentAttemptedAt} IS NULL
          OR ${promoters.enrichmentAttemptedAt} < ${staleCutoff}
        )`
    )
    .orderBy(sql`${promoters.enrichmentAttemptedAt} IS NULL DESC`)
    .limit(NIGHTLY_LIMIT);

  if (!env.PROMOTER_ENRICHMENT) {
    await logError(env.DB, {
      level: "warn",
      source: "mcp:promoter-enrichment:selector",
      message: "PROMOTER_ENRICHMENT queue not bound — selected but did not enqueue",
      context: { selected: rows.length, jobRunId },
    });
    return { jobRunId, enqueued: 0, dryRun };
  }

  let enqueued = 0;
  const SEND_BATCH = 100;
  for (let i = 0; i < rows.length; i += SEND_BATCH) {
    const chunk = rows.slice(i, i + SEND_BATCH);
    try {
      await env.PROMOTER_ENRICHMENT.sendBatch(
        chunk.map((r) => ({ body: { promoterId: r.id, jobRunId, dryRun } }))
      );
      enqueued += chunk.length;
    } catch (err) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:promoter-enrichment:selector",
        message: "failed to enqueue promoter enrichment job batch",
        error: err,
        context: { promoterIds: chunk.map((r) => r.id), jobRunId, chunkSize: chunk.length },
      });
    }
  }
  return { jobRunId, enqueued, dryRun };
}
