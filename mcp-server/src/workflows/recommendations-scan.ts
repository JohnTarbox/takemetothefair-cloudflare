/**
 * Recommendations scan — Cloudflare Workflow.
 *
 * Replaces the old `runScheduledRecommendationsScan` function that ran a
 * chunked cursor loop within a single `scheduled()` Worker invocation
 * (chunks of 8 rules × MAX_CHUNKS=50 against Cloudflare's 30s response
 * cap). The Workflow version keeps the same cursor-loop logic but each
 * chunk is its own durable `step.do` with retry, so transient main-app
 * failures don't burn the whole sweep on the next day's cron.
 *
 * Triggered from the daily `0 6 * * *` cron in the MCP Worker's
 * scheduled() handler via `env.RECOMMENDATIONS_SCAN.create({})`.
 *
 * Failure contract (post-PR May 2026):
 *   - 5xx / network          → plain Error, step retries (limit:2, exp backoff).
 *   - 4xx                    → NonRetryableError, step skips retries; loop breaks.
 *   - Logging lives in the outer catch so retries don't produce duplicate
 *     log entries (CF Workflows rules-of-workflows side-effect caveat).
 *
 * Audit doc: docs/cloudflare-workflows-audit.md.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { logError } from "../logger.js";

/** No instance params — cron-triggered with empty payload. Defined for
 *  forward-compat if we want to override MAX_CHUNKS or start cursor later. */
export type RecommendationsScanParams = {
  maxChunks?: number;
  startCursor?: number;
};

type Env = {
  DB: D1Database;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
  MAIN_APP?: { fetch: typeof fetch };
};

interface ChunkResponse {
  success?: boolean;
  data?: {
    scannedRules?: number;
    inserted?: number;
    resolved?: number;
    failedRules?: number;
    nextCursor?: number;
    more?: boolean;
  };
}

const DEFAULT_MAX_CHUNKS = 50;
const SOURCE = "mcp:workflow:recommendations-scan";

export class RecommendationsScanWorkflow extends WorkflowEntrypoint<
  Env,
  RecommendationsScanParams
> {
  async run(event: WorkflowEvent<RecommendationsScanParams>, step: WorkflowStep) {
    const maxChunks = event.payload.maxChunks ?? DEFAULT_MAX_CHUNKS;
    let cursor = event.payload.startCursor ?? 0;
    let chunks = 0;
    const totals = { scannedRules: 0, inserted: 0, resolved: 0, failedRules: 0 };

    while (chunks < maxChunks) {
      chunks++;
      const chunkNum = chunks;
      const cursorForLog = cursor;

      let result: ChunkResponse;
      try {
        result = await step.do(
          `scan-chunk-${chunkNum}`,
          {
            // 5-minute timeout: per-chunk work varies a lot because each
            // recommendation rule has its own scan cost (one rule matched
            // 260 items in a real run). Empirically 22s for light chunks,
            // can exceed 45s for heavier ones. 5 min is generous but still
            // bounded — at limit:2 retries that caps worst-case per-chunk
            // wall-clock at 15 min.
            retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
            timeout: "5 minutes",
          },
          async (): Promise<ChunkResponse> => {
            // chunk=4 halves the endpoint's default of 8 rules per chunk.
            // The default sized chunks have been hitting Cloudflare's
            // ~100s Worker→Pages edge timeout (HTTP 524) on heavy rules
            // — observed daily at cursor 8 in production through
            // mid-May 2026. Halving the rules-per-chunk roughly halves
            // wall-clock per chunk (each rule is awaited sequentially
            // in engine.ts's evaluateRules loop), buying ~44s headroom
            // instead of ~22s. More total chunks needed but each is
            // safely under budget; MAX_CHUNKS=50 still covers all 23
            // rules with room to spare.
            const url = `${this.env.MAIN_APP_URL}/api/admin/recommendations/scan?cursor=${cursorForLog}&chunk=4`;
            const init: RequestInit = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Key": this.env.INTERNAL_API_KEY,
              },
            };
            const response = this.env.MAIN_APP
              ? await this.env.MAIN_APP.fetch(new Request(url, init))
              : await fetch(url, init);
            if (response.status >= 500) {
              // Transient — step retries.
              const text = await response.text().catch(() => "<unreadable>");
              throw new Error(`recommendations-scan 5xx@${cursorForLog}: ${text.slice(0, 200)}`);
            }
            if (!response.ok) {
              // Permanent — outer catch logs once and breaks the loop.
              const text = await response.text().catch(() => "<unreadable>");
              throw new NonRetryableError(
                `recommendations-scan ${response.status}@${cursorForLog}: ${text.slice(0, 200)}`
              );
            }
            return (await response.json()) as ChunkResponse;
          }
        );
      } catch (err) {
        // Either step exhausted retries (5xx after limit:2) OR threw
        // NonRetryableError (4xx). Both cases: log once + break the
        // sweep. Tomorrow's cron will retry from cursor=0.
        const isNonRetryable = err instanceof NonRetryableError;
        await logError(this.env.DB, {
          source: SOURCE,
          message: isNonRetryable
            ? "chunk threw NonRetryableError (4xx); aborting sweep"
            : "chunk exhausted retries (5xx / transient); aborting sweep",
          error: err,
          sessionId: event.instanceId,
          context: {
            cursor: cursorForLog,
            chunk: chunkNum,
            totals,
            nonRetryable: isNonRetryable,
          },
        });
        break;
      }

      const d = result.data;
      if (!d) {
        await logError(this.env.DB, {
          source: SOURCE,
          message: "chunk returned no data field",
          sessionId: event.instanceId,
          context: { cursor: cursorForLog, chunk: chunkNum },
        });
        break;
      }
      totals.scannedRules += d.scannedRules ?? 0;
      totals.inserted += d.inserted ?? 0;
      totals.resolved += d.resolved ?? 0;
      totals.failedRules += d.failedRules ?? 0;
      cursor = d.nextCursor ?? cursor;
      if (!d.more) break;
    }

    return {
      chunks,
      cursorReached: cursor,
      cappedAtMaxChunks: chunks >= maxChunks,
      ...totals,
    };
  }
}
