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
 * Failure contract (post-PR May 2026):
 *   - 5xx / network          → plain Error, step retries (limit:2, exp backoff).
 *   - 4xx                    → NonRetryableError, step skips retries; loop breaks.
 *   - Logging lives in the outer catch so retries don't produce duplicate
 *     log entries (CF Workflows rules-of-workflows side-effect caveat).
 *
 * Audit doc: docs/cloudflare-workflows-audit.md.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { mainAppBindingRequest } from "../main-app-fetch.js";
import { NonRetryableError } from "cloudflare:workflows";
import { logError } from "../logger.js";
import { getDb } from "../db.js";
import { DEFAULT_URLS_PER_CALL, runCancellationRecheck } from "../goodwill/cancellation-recheck.js";
import {
  captureSourceAgreementDisagreements,
  type SourceDisagreementFinding,
} from "../goodwill/source-agreement-capture.js";

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

      let result: ChunkResponse;
      try {
        result = await step.do(
          `drift-chunk-${chunkNum}`,
          {
            // 5-minute timeout: each chunk refetches up to 200 source URLs
            // with their own per-URL timeout. Observed 45s+ in initial
            // production runs. 5 min is generous but still bounded.
            retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
            timeout: "5 minutes",
          },
          async (): Promise<ChunkResponse> => {
            // chunk=50 keeps each sweep call under Cloudflare's ~100s
            // Worker→Pages edge timeout (HTTP 524). Default endpoint
            // chunk size is 200; that produced ~2-minute per-chunk runs
            // which exceed the edge budget. 50 events × per-URL fetch
            // ≈ 30-45s, comfortably under 100s. More chunks needed
            // total but cap is still MAX_CHUNKS=50 so we cover up to
            // 2500 events per workflow run.
            const url = `${this.env.MAIN_APP_URL}/api/admin/event-date-drift/sweep?cursor=${cursorForLog}&chunk=50`;
            const init: RequestInit = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Key": this.env.INTERNAL_API_KEY,
              },
            };
            const response = this.env.MAIN_APP
              ? await this.env.MAIN_APP.fetch(mainAppBindingRequest(url, init))
              : await fetch(url, init);
            if (response.status >= 500) {
              // Transient — step retries.
              const text = await response.text().catch(() => "<unreadable>");
              throw new Error(`event-date-drift 5xx@${cursorForLog}: ${text.slice(0, 200)}`);
            }
            if (!response.ok) {
              // Permanent — outer catch logs once and breaks the loop.
              const text = await response.text().catch(() => "<unreadable>");
              throw new NonRetryableError(
                `event-date-drift ${response.status}@${cursorForLog}: ${text.slice(0, 200)}`
              );
            }
            return (await response.json()) as ChunkResponse;
          }
        );
      } catch (err) {
        // Either step exhausted retries (5xx after limit:2) OR threw
        // NonRetryableError (4xx). Both cases: log once + break.
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

      totals.scanned += result.scanned ?? 0;
      totals.drift_recorded += result.drift_recorded ?? 0;
      totals.fetch_failed += result.fetch_failed ?? 0;
      if (result.next_cursor == null) break;
      cursor = result.next_cursor;
    }

    // OPE-868 — promoter website health, on the same daily run.
    //
    // A separate sweep with its own endpoint and cursor (its contract is link
    // health, not date drift), but driven from here rather than from a new cron
    // trigger. Two reasons: this workflow already holds the MAIN_APP binding
    // and the internal key, and a sweep nobody schedules is inert — which is
    // the amendment-H failure wearing a different hat.
    //
    // Sized from a real count: 612 DISTINCT promoter websites in prod on
    // 2026-09-09, so 13 chunks of 50 covers the estate. 15 is that plus
    // headroom for growth. It runs AFTER the drift loop and its failures are
    // logged and swallowed — a link-health problem must never abort the date
    // sweep, which is the older and more load-bearing job.
    const urlHealth = { chunks: 0, examined: 0, actionable: 0, failed: false };
    let uhCursor = 0;
    for (let i = 0; i < 15; i++) {
      try {
        const res = await step.do(
          `promoter-url-health-${i + 1}`,
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" },
          async (): Promise<{
            examined: number;
            actionable: number;
            next_cursor: number | null;
          }> => {
            // chunk=50 for the same MEASURED reason as the drift loop above:
            // 50 URLs x one per-URL fetch is ~30-45s, under the ~100s
            // Worker->Pages edge budget. Same operation, same bound.
            const u = `${this.env.MAIN_APP_URL}/api/admin/url-health/promoters/sweep?cursor=${uhCursor}&chunk=50`;
            const init: RequestInit = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Key": this.env.INTERNAL_API_KEY,
              },
            };
            const r = this.env.MAIN_APP
              ? await this.env.MAIN_APP.fetch(mainAppBindingRequest(u, init))
              : await fetch(u, init);
            if (!r.ok) throw new Error(`url-health ${r.status}@${uhCursor}`);
            return (await r.json()) as {
              examined: number;
              actionable: number;
              next_cursor: number | null;
            };
          }
        );
        urlHealth.chunks++;
        urlHealth.examined += res.examined ?? 0;
        urlHealth.actionable += res.actionable ?? 0;
        if (res.next_cursor == null) break;
        uhCursor = res.next_cursor;
      } catch (err) {
        urlHealth.failed = true;
        await logError(this.env.DB, {
          source: SOURCE,
          message: "promoter url-health chunk failed; drift results are unaffected",
          error: err,
          sessionId: event.instanceId,
          context: { cursor: uhCursor, chunk: i + 1, urlHealth },
        });
        break;
      }
    }

    // OPE-987 — re-read upcoming events' organizer pages for a cancellation
    // notice (cape-cod-brew-fest sat SCHEDULED for ~39 days after its page said
    // "2026 Festival Canceled").
    //
    // On this daily run for the same reason as the promoter sweep above: a pass
    // nobody schedules is inert. It runs IN this Worker, not through a main-app
    // route, because the discrepancy writer (captureDiscrepancy) lives here and
    // the main app deliberately does not write event_discrepancies directly.
    //
    // Sized from the measured candidate set, not by analogy: 186 events in the
    // 30-day window on 2026-09-13 → 136 DISTINCT organizer urls after the
    // third-party exclusion. 20 urls per step (worst case 20 × 10s fetch
    // timeout = 200s, inside the 5-minute step) × 10 steps = 200 covers that
    // with headroom; the loop stops as soon as nothing is due. Failures are
    // logged and swallowed — this must never abort the date sweep.
    const cancellation = {
      steps: 0,
      examined: 0,
      notices: 0,
      opened: 0,
      remaining: 0,
      failed: false,
      // OPE-1099 — the named coverage gap: events no organizer page covers.
      // Selection-level, so the same on every call; the last call's value is kept.
      rescuedViaAlternate: 0,
      unverifiable: [] as string[],
      thirdPartyStillLive: 0,
      thirdPartyCaughtUp: 0,
    };
    for (let i = 0; i < 10; i++) {
      try {
        const res = await step.do(
          `organizer-cancellation-recheck-${i + 1}`,
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" },
          async () => {
            const r = await runCancellationRecheck(getDb(this.env.DB), {
              limit: DEFAULT_URLS_PER_CALL,
            });
            return {
              examined: r.examined,
              notices: r.notices,
              opened: r.discrepanciesOpened,
              remaining: r.remaining,
              rescuedViaAlternate: r.rescuedViaAlternate,
              unverifiable: r.unverifiable,
              thirdPartyStillLive: r.thirdPartyStillLive,
              thirdPartyCaughtUp: r.thirdPartyCaughtUp,
            };
          }
        );
        cancellation.steps++;
        cancellation.examined += res.examined;
        cancellation.notices += res.notices;
        cancellation.opened += res.opened;
        cancellation.remaining = res.remaining;
        cancellation.rescuedViaAlternate = res.rescuedViaAlternate;
        cancellation.unverifiable = res.unverifiable;
        cancellation.thirdPartyStillLive += res.thirdPartyStillLive;
        cancellation.thirdPartyCaughtUp += res.thirdPartyCaughtUp;
        if (res.remaining === 0 || res.examined === 0) break;
      } catch (err) {
        cancellation.failed = true;
        await logError(this.env.DB, {
          source: SOURCE,
          message: "organizer cancellation recheck step failed; drift results are unaffected",
          error: err,
          sessionId: event.instanceId,
          context: { step: i + 1, cancellation },
        });
        break;
      }
    }

    // OPE-988 — does each organizer page an event cites name that event's
    // town, and is its domain still the organizer's? Same daily run, same
    // reasons as the promoter sweep above: this workflow holds the binding and
    // the key, and a sweep nobody schedules is inert. Also after the drift loop,
    // also swallowed on failure.
    //
    // Sized from a real count, not by analogy: 516 distinct source URLs on
    // events starting within [-30d, +120d] in prod on 2026-09-13 (before the
    // aggregator/platform filter, which only shrinks it) = 11 chunks of 50.
    // 15 is that plus headroom. The route reports `organizer_urls_total`, so a
    // cap that stops being enough is visible in this return value.
    const sourceAgreement = {
      chunks: 0,
      examined: 0,
      organizer_urls_total: 0,
      disagreements: 0,
      filed: 0,
      takeovers: 0,
      failed: false,
    };
    let saCursor = 0;
    for (let i = 0; i < 15; i++) {
      try {
        const res = await step.do(
          `source-agreement-${i + 1}`,
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" },
          async (): Promise<{
            examined: number;
            organizer_urls_total: number;
            domain_takeover: number;
            disagreements: SourceDisagreementFinding[];
            next_cursor: number | null;
          }> => {
            // chunk=50: the same measured per-URL fetch bound as both loops above.
            const u = `${this.env.MAIN_APP_URL}/api/admin/url-health/source-agreement/sweep?cursor=${saCursor}&chunk=50`;
            const init: RequestInit = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Key": this.env.INTERNAL_API_KEY,
              },
            };
            const r = this.env.MAIN_APP
              ? await this.env.MAIN_APP.fetch(mainAppBindingRequest(u, init))
              : await fetch(u, init);
            if (!r.ok) throw new Error(`source-agreement ${r.status}@${saCursor}`);
            return (await r.json()) as {
              examined: number;
              organizer_urls_total: number;
              domain_takeover: number;
              disagreements: SourceDisagreementFinding[];
              next_cursor: number | null;
            };
          }
        );
        sourceAgreement.chunks++;
        sourceAgreement.examined += res.examined ?? 0;
        sourceAgreement.organizer_urls_total = res.organizer_urls_total ?? 0;
        sourceAgreement.takeovers += res.domain_takeover ?? 0;
        const findings = Array.isArray(res.disagreements) ? res.disagreements : [];
        sourceAgreement.disagreements += findings.length;
        if (findings.length > 0) {
          // Its own step so a retried fetch step never re-files, and a failed
          // write retries without re-fetching 50 pages. captureDiscrepancy is
          // idempotent on the open row either way.
          const captured = await step.do(
            `source-agreement-capture-${i + 1}`,
            { retries: { limit: 2, delay: "5 seconds" }, timeout: "1 minute" },
            async () => captureSourceAgreementDisagreements(getDb(this.env.DB), findings)
          );
          sourceAgreement.filed += captured.filed;
        }
        if (res.next_cursor == null) break;
        saCursor = res.next_cursor;
      } catch (err) {
        sourceAgreement.failed = true;
        await logError(this.env.DB, {
          source: SOURCE,
          message: "source-agreement chunk failed; drift results are unaffected",
          error: err,
          sessionId: event.instanceId,
          context: { cursor: saCursor, chunk: i + 1, sourceAgreement },
        });
        break;
      }
    }

    return {
      chunks,
      cursorReached: cursor,
      cappedAtMaxChunks: chunks >= maxChunks,
      ...totals,
      url_health: urlHealth,
      cancellation_recheck: cancellation,
      source_agreement: sourceAgreement,
    };
  }
}
