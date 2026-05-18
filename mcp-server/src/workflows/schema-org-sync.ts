/**
 * Canonical schema-org sync — driven by Cloudflare Workflows.
 *
 * Each input event becomes a `step.do` with per-step retry. The step body
 * HTTP-calls the main app's `/api/admin/schema-org/sync-one` endpoint with
 * X-Internal-Key — same pattern as the cron sweeps in `index.ts`. Keeping
 * the actual fetch + DB write in the main app means we don't have to
 * hoist `fetchSchemaOrg` into a shared workspace package, and the
 * Workflow stays a pure orchestrator.
 *
 * Replaced the older `/api/admin/schema-org/sync` chunked POST endpoint,
 * which was capped at 50 events per call to fit Cloudflare's 30s response
 * budget. This path handles arbitrarily many events durably.
 *
 * Triggered via `POST /api/admin/schema-org/sync-workflow/start`
 * (accepts explicit `eventIds[]` or `mode: "missing" | "existing" | "all"`).
 * Status polled via `GET /api/admin/schema-org/sync-workflow/[id]/status`.
 *
 * Per-step retry policy is intentionally tight: `limit: 2, delay: 5s,
 * constant backoff, timeout: 30s`. Schema-org sync failures are usually
 * page-content issues (no JSON-LD on the page) or origin 4xx — retrying
 * many times against the same URL doesn't help, and we'd rather move on
 * to the next event than block the whole workflow on one stubborn URL.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { logError } from "../logger.js";

export type SchemaOrgSyncParams = {
  /** Event IDs to process. Caller resolves the list (either explicit user
   *  selection or by querying the events table via the start endpoint's
   *  `mode` parameter). Cap at 1000 per instance. */
  eventIds: string[];
  /** Per-event delay between calls. 500ms default matches the original
   *  /sync endpoint's rate-limit safeguard against hammering origins. */
  delayMs?: number;
};

type Env = {
  DB: D1Database;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
  /** Optional Pages service binding — not used today (Pages binding is
   *  disabled in wrangler.toml), kept for forward-compat. */
  MAIN_APP?: { fetch: typeof fetch };
};

/** Response from /api/admin/schema-org/sync-one — mirrors the per-event
 *  result the old endpoint's loop emitted. */
type SyncOneResponse = {
  success: boolean;
  eventId: string;
  eventName?: string;
  status: string;
  error?: string | null;
};

export class SchemaOrgSyncWorkflow extends WorkflowEntrypoint<Env, SchemaOrgSyncParams> {
  async run(event: WorkflowEvent<SchemaOrgSyncParams>, step: WorkflowStep) {
    const { eventIds, delayMs = 500 } = event.payload;
    const cap = Math.min(eventIds.length, 1000);
    const ids = eventIds.slice(0, cap);

    let success = 0;
    let failure = 0;
    let notFound = 0;
    // Per-event results — admin UI displays these as success/fail tables
    // and uses the failed list for the "retry selected" button. Capped
    // at 1000 events × ~200 bytes ≈ 200KB, well under the 1MB output limit.
    const results: SyncOneResponse[] = [];

    for (const eventId of ids) {
      try {
        const result = await step.do(
          `sync-${eventId}`,
          {
            retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
            timeout: "30 seconds",
          },
          async () => {
            // Each step is one HTTP POST to the main app, which owns the
            // canonical fetchSchemaOrg + the schema-org-row upsert logic.
            // Service binding fallback in case we ever wire it up; today
            // we always go through public HTTPS.
            const url = `${this.env.MAIN_APP_URL}/api/admin/schema-org/sync-one`;
            const init: RequestInit = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-internal-key": this.env.INTERNAL_API_KEY,
              },
              body: JSON.stringify({ eventId }),
            };

            const response = this.env.MAIN_APP
              ? await this.env.MAIN_APP.fetch(new Request(url, init))
              : await fetch(url, init);

            // 5xx → throw so step.do retries. 4xx + 2xx → return the body
            // for accumulation. The sync-one endpoint returns 200 for
            // "fetched but no JSON-LD on the page" (status=not_found),
            // and 404 for "event row doesn't exist" — both are terminal
            // for this event but not workflow-fatal.
            if (response.status >= 500) {
              const text = await response.text().catch(() => "<unreadable>");
              throw new Error(`sync-one 5xx for ${eventId}: ${text.slice(0, 200)}`);
            }
            return (await response.json()) as SyncOneResponse;
          }
        );

        results.push(result);
        if (result.success) {
          success++;
        } else if (result.status === "not_found" || result.status === "event_not_found") {
          notFound++;
        } else {
          failure++;
        }
      } catch (err) {
        // Step exhausted retries (2 attempts × 30s timeout each) — log
        // and continue. One stubborn event shouldn't block the whole
        // workflow.
        await logError(this.env.DB, {
          source: "mcp:workflow:schema-org-sync",
          message: "step exhausted retries; continuing with next event",
          error: err,
          sessionId: event.instanceId,
          context: { eventId, totalEvents: ids.length },
        });
        failure++;
        results.push({
          success: false,
          eventId,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Throttle between events. `step.sleep` is durable — survives
      // Worker restarts and doesn't count against the step limit.
      if (delayMs > 0) await step.sleep(`delay-${eventId}`, delayMs);
    }

    return {
      processed: ids.length,
      success,
      failure,
      notFound,
      capped: eventIds.length > cap,
      results,
    };
  }
}
