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
 * Failure contract (post-PR May 2026):
 *   - 5xx / network          → plain Error, step retries (limit:2).
 *   - 4xx / unparseable body → NonRetryableError, step skips retries.
 *   - Either kind, after the step terminates, the loop's outer catch
 *     logs once and continues to the next event. Logging lives OUTSIDE
 *     the step body so a retry doesn't produce duplicate entries
 *     (CF Workflows' rules-of-workflows side-effect caveat).
 *
 * Per-step retry policy is tight: `limit: 2, delay: 5s, constant backoff,
 * timeout: 30s`. Schema-org sync failures are usually page-content issues
 * (no JSON-LD on the page) or origin 4xx — retrying many times against
 * the same URL doesn't help, and we'd rather move on to the next event
 * than block the whole workflow on one stubborn URL.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
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

const SOURCE = "mcp:workflow:schema-org-sync";

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

            if (response.status >= 500) {
              // Transient — step retries.
              const text = await response.text().catch(() => "<unreadable>");
              throw new Error(`sync-one 5xx for ${eventId}: ${text.slice(0, 200)}`);
            }
            if (!response.ok) {
              // 4xx — permanent for this URL; bubble out so the outer
              // catch records it as a per-event failure and the loop
              // continues. The /sync-one endpoint emits 2xx with
              // `success:false` for the common "no JSON-LD on page"
              // case, so a true 4xx here means a malformed request or
              // permission issue — not retryable.
              const text = await response.text().catch(() => "<unreadable>");
              throw new NonRetryableError(
                `sync-one ${response.status} for ${eventId}: ${text.slice(0, 200)}`
              );
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
        // Step terminated (NonRetryableError on 4xx, or step exhausted
        // its 2-retry budget on 5xx). Log once + continue. Logging
        // here rather than inside the step body avoids duplicate log
        // entries when retries fire — per CF Workflows rules of side
        // effects in step.do callbacks.
        const isNonRetryable = err instanceof NonRetryableError;
        await logError(this.env.DB, {
          source: SOURCE,
          message: isNonRetryable
            ? "step threw NonRetryableError (4xx / permanent); continuing"
            : "step exhausted retries (5xx / transient); continuing",
          error: err,
          sessionId: event.instanceId,
          context: { eventId, totalEvents: ids.length, nonRetryable: isNonRetryable },
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
