/**
 * Event-date-drift sweep — Cloudflare Workflow.
 *
 * Replaces the old `runScheduledEventDateDrift` function that ran a
 * chunked cursor loop against `/api/admin/event-date-drift/sweep`
 * (200 events per chunk × MAX_CHUNKS=50). The sweep refetches the
 * canonical source URL for APPROVED events with start_date 30-90 days
 * out and records drift > 1 day in event_date_drift_findings.
 *
 * Same shape and rationale as RecommendationsScanWorkflow — each chunk
 * is its own durable step with retry. Triggered from the daily
 * `0 6 * * *` cron via `env.EVENT_DATE_DRIFT.create({})`.
 *
 * Audit doc: docs/cloudflare-workflows-audit.md (Phase 2 candidate).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { logError } from "../logger.js";

export type EventDateDriftParams = {
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
  scanned?: number;
  drift_recorded?: number;
  fetch_failed?: number;
  next_cursor?: number | null;
}

const DEFAULT_MAX_CHUNKS = 50;
const SOURCE = "mcp:workflow:event-date-drift";

export class EventDateDriftWorkflow extends WorkflowEntrypoint<Env, EventDateDriftParams> {
  async run(event: WorkflowEvent<EventDateDriftParams>, step: WorkflowStep) {
    const maxChunks = event.payload.maxChunks ?? DEFAULT_MAX_CHUNKS;
    let cursor = event.payload.startCursor ?? 0;
    let chunks = 0;
    const totals = { scanned: 0, drift_recorded: 0, fetch_failed: 0 };

    while (chunks < maxChunks) {
      chunks++;
      const chunkNum = chunks;
      const cursorForLog = cursor;

      try {
        const result = await step.do(
          `drift-chunk-${chunkNum}`,
          {
            // 5-minute timeout: each chunk refetches up to 200 source URLs
            // with their own per-URL timeout. Observed 45s+ in initial
            // production runs. 5 min is generous but still bounded.
            retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
            timeout: "5 minutes",
          },
          async (): Promise<ChunkResponse> => {
            const url = `${this.env.MAIN_APP_URL}/api/admin/event-date-drift/sweep?cursor=${cursorForLog}`;
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
              const text = await response.text().catch(() => "<unreadable>");
              throw new Error(`event-date-drift 5xx@${cursorForLog}: ${text.slice(0, 200)}`);
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
              return {} as ChunkResponse;
            }
            return (await response.json()) as ChunkResponse;
          }
        );

        totals.scanned += result.scanned ?? 0;
        totals.drift_recorded += result.drift_recorded ?? 0;
        totals.fetch_failed += result.fetch_failed ?? 0;
        if (result.next_cursor == null) break;
        cursor = result.next_cursor;
      } catch (err) {
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
