// I1 vendor-enrichment candidate selector (Dev-Brief-I1 §4/§6.3, 2026-06-13).
//
// The nightly cron picks ≤100 "population-1" vendors and enqueues one
// enrichment job each. Selection is FIELD-BASED, not completeness-score-based:
// the audit (2026-06-12) showed the completeness rubric weights description/
// type/products/claimed 65pts and contact fields only 10pts (0 for social/
// address), so a score gate would skip ~700 vendors that still miss email/
// social/address. We select on actual blank fields instead, prioritizing
// never-attempted vendors, then stale (>30d) ones.
import { sql } from "drizzle-orm";
import { vendors } from "../schema.js";
import { getDb } from "../db.js";
import { logError } from "../logger.js";
import type { VendorEnrichmentMessage } from "./dispatch.js";

/** ≤100/night — slower-is-safer on the first sweep over ~970 rows (§4). */
const NIGHTLY_LIMIT = 100;
/** Re-attempt a vendor at most once per 30 days. */
const REATTEMPT_DAYS = 30;

export interface SelectorEnv {
  DB: D1Database;
  VENDOR_ENRICHMENT?: Queue<VendorEnrichmentMessage>;
  /** Operator switch — "false" flips off the Phase-1 dry-run default. */
  ENRICHMENT_DRY_RUN?: string;
}

export interface SelectionResult {
  jobRunId: string;
  enqueued: number;
  dryRun: boolean;
}

/**
 * Cron entrypoint. Idempotent enough to re-run: the 30-day attempt window +
 * the dispatcher's clear-and-restage keep duplicates from piling up.
 *
 * `jobRunId` must be supplied by the caller (the scheduled() handler) because
 * crypto.randomUUID() is the cron's to mint — keeping this function free of
 * ambient randomness makes it unit-testable.
 */
export async function runScheduledVendorEnrichment(
  env: SelectorEnv,
  jobRunId: string,
  nowMs: number
): Promise<SelectionResult> {
  const db = getDb(env.DB);
  const dryRun = env.ENRICHMENT_DRY_RUN !== "false";
  const staleCutoff = Math.floor((nowMs - REATTEMPT_DAYS * 86_400_000) / 1000);

  // Field-based "population-1": has a website, not domain-flagged, and missing
  // at least one of phone/email/social/address. Never-attempted first
  // (enrichment_attempted_at IS NULL sorts ahead), then lowest completeness.
  const rows = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(
      sql`${vendors.deletedAt} IS NULL
        AND ${vendors.website} IS NOT NULL AND TRIM(${vendors.website}) <> ''
        AND ${vendors.domainHijacked} = 0
        AND (
          (${vendors.contactPhone} IS NULL OR TRIM(${vendors.contactPhone}) = '')
          OR (${vendors.contactEmail} IS NULL OR TRIM(${vendors.contactEmail}) = '')
          OR (${vendors.socialLinks} IS NULL OR TRIM(${vendors.socialLinks}) = ''
              OR ${vendors.socialLinks} = '{}' OR ${vendors.socialLinks} = '[]')
          OR (${vendors.address} IS NULL OR TRIM(${vendors.address}) = '')
        )
        AND (
          ${vendors.enrichmentAttemptedAt} IS NULL
          OR ${vendors.enrichmentAttemptedAt} < ${staleCutoff}
        )`
    )
    .orderBy(
      sql`${vendors.enrichmentAttemptedAt} IS NULL DESC`,
      sql`${vendors.completenessScore} ASC`
    )
    .limit(NIGHTLY_LIMIT);

  if (!env.VENDOR_ENRICHMENT) {
    await logError(env.DB, {
      level: "warn",
      source: "mcp:enrichment:selector",
      message: "VENDOR_ENRICHMENT queue not bound — selected but did not enqueue",
      context: { selected: rows.length, jobRunId },
    });
    return { jobRunId, enqueued: 0, dryRun };
  }

  // Enqueue with sendBatch (≤100 messages/call) instead of one send() per
  // vendor — the nightly run selects up to NIGHTLY_LIMIT rows, so this is one
  // subrequest instead of up to 100.
  let enqueued = 0;
  const SEND_BATCH = 100;
  for (let i = 0; i < rows.length; i += SEND_BATCH) {
    const chunk = rows.slice(i, i + SEND_BATCH);
    try {
      await env.VENDOR_ENRICHMENT.sendBatch(
        chunk.map((r) => ({ body: { vendorId: r.id, jobRunId, dryRun } }))
      );
      enqueued += chunk.length;
    } catch (err) {
      await logError(env.DB, {
        level: "warn",
        source: "mcp:enrichment:selector",
        message: "failed to enqueue enrichment job batch",
        error: err,
        context: { vendorIds: chunk.map((r) => r.id), jobRunId, chunkSize: chunk.length },
      });
    }
  }
  return { jobRunId, enqueued, dryRun };
}
