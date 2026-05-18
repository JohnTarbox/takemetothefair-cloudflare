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
 * Why Workflow:
 *   - Per-chunk retry (default 3 attempts with exponential backoff) —
 *     transient 5xx from main app gets recovered without a full re-run.
 *   - No 30s per-invocation cap — each chunk is its own step with its
 *     own timeout budget.
 *   - Durable: a Worker restart mid-sweep doesn't restart the whole
 *     scan; Workflows resumes from the last completed step.
 *
 * Audit doc: docs/cloudflare-workflows-audit.md (this is Phase 2,
 * candidate scored 9/12 — strongest migration fit after schema-org-sync).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
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

      try {
        const result = await step.do(
          `scan-chunk-${chunkNum}`,
          {
            retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
            timeout: "45 seconds",
          },
          async (): Promise<ChunkResponse> => {
            const url = `${this.env.MAIN_APP_URL}/api/admin/recommendations/scan?cursor=${cursorForLog}`;
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
            // 5xx → throw so step.do retries. 4xx → fail terminally for this
            // step; the catch below logs and breaks the loop.
            if (response.status >= 500) {
              const text = await response.text().catch(() => "<unreadable>");
              throw new Error(`recommendations-scan 5xx@${cursorForLog}: ${text.slice(0, 200)}`);
            }
            if (!response.ok) {
              const text = await response.text().catch(() => "<unreadable>");
              await logError(this.env.DB, {
                source: SOURCE,
                message: "chunk returned non-2xx (non-retryable)",
                statusCode: response.status,
                sessionId: event.instanceId,
                context: { cursor: cursorForLog, chunk: chunkNum, bodyExcerpt: text.slice(0, 500) },
              });
              return {} as ChunkResponse; // signals empty data → loop breaks
            }
            return (await response.json()) as ChunkResponse;
          }
        );

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
      } catch (err) {
        // step exhausted retries — log + break.
        await logError(this.env.DB, {
          source: SOURCE,
          message: "step exhausted retries; aborting sweep",
          error: err,
          sessionId: event.instanceId,
          context: { cursor: cursorForLog, chunk: chunkNum, totals },
        });
        break;
      }
    }

    return {
      chunks,
      cursorReached: cursor,
      cappedAtMaxChunks: chunks >= maxChunks,
      ...totals,
    };
  }
}
