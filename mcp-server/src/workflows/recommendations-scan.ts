/**
 * Recommendations scan — Cloudflare Workflow.
 *
 * REL3 rewrite (2026-06-08): switched from "scan everything in one
 * Workflow instance per cron" to "scan N chunks per cron, persist
 * cursor, resume on next cron." The prior shape ran ALL 23 rules in
 * one Workflow loop with a `step.do` per chunk (chunk=4 rules). A
 * single slow rule that exceeded the 5-minute per-step timeout
 * aborted the whole sweep; production logged 24 such aborts across
 * 22 distinct days (2026-05-18 → 2026-06-08) before this rewrite.
 *
 * New shape:
 *   read-cursor      → SELECT cursor FROM recommendation_scan_state
 *   scan-chunk × N   → step.do per chunk; each calls the chunked
 *                      /api/admin/recommendations/scan endpoint with
 *                      the current cursor; advance cursor on success
 *   persist-cursor   → UPDATE recommendation_scan_state with new
 *                      cursor + completed_cycles + run timing
 *
 * Cycle period = ceil(ALL_RULES.length / (N × chunk)) days. With 23
 * rules, N=3 invocations/day, chunk=4 rules → ceil(23 / 12) = 2 days.
 * The recommendation feed converges to "tail is at most 2 days stale"
 * once REL3 lands.
 *
 * Triggered from the daily `0 6 * * *` cron in the MCP Worker's
 * scheduled() handler via `env.RECOMMENDATIONS_SCAN.create({})`.
 *
 * Failure contract (preserved from the 2026-05-19 shape):
 *   - 5xx / network          → plain Error, step retries (limit:1, exp backoff).
 *     Lowered from limit:2 because each per-chunk failure now only burns
 *     ~5min instead of the whole sweep, so being slightly faster to give
 *     up is fine.
 *   - 4xx                    → NonRetryableError, step skips retries.
 *   - Logging in outer catch  → one error_logs row per failed chunk; the
 *     standing-failure detector ([[mcp-server/src/standing-failure-canary.ts]])
 *     watches for these recurring across days as the safety net REL3
 *     should never trip but A5 catches if it does.
 *
 * Audit doc: docs/cloudflare-workflows-audit.md.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { recommendationScanState } from "@takemetothefair/db-schema";
import { logError } from "../logger.js";
import { getDb } from "../db.js";

/** Override knobs (forward-compat for ops triage; cron passes empty payload). */
export type RecommendationsScanParams = {
  /** Hard cap on chunks per invocation. Default 3. */
  chunksPerInvocation?: number;
  /** Override the starting cursor (debugging). Default reads from D1. */
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
    totalRules?: number;
    /** REL3 (drizzle/0116, 2026-06-08) — per-rule timing for slow-rule
     *  detection. ms per rule, indexed by ruleKey. */
    ruleTimings?: Record<string, number>;
  };
}

const DEFAULT_CHUNKS_PER_INVOCATION = 3;
const STATE_ID = "default";
const SLOW_RULE_THRESHOLD_MS = 60_000;
const SOURCE = "mcp:workflow:recommendations-scan";

export class RecommendationsScanWorkflow extends WorkflowEntrypoint<
  Env,
  RecommendationsScanParams
> {
  async run(event: WorkflowEvent<RecommendationsScanParams>, step: WorkflowStep) {
    const chunksPerInvocation = event.payload.chunksPerInvocation ?? DEFAULT_CHUNKS_PER_INVOCATION;
    const db = getDb(this.env.DB);

    // ── Step 1: read cursor ─────────────────────────────────────────
    // Pre-seeded by drizzle/0116 so the row always exists; SELECT here
    // never returns empty.
    const initial = await step.do("read-cursor", async () => {
      if (event.payload.startCursor !== undefined) {
        return { cursor: event.payload.startCursor, completedCycles: 0 } as const;
      }
      const rows = await db
        .select({
          cursor: recommendationScanState.cursor,
          completedCycles: recommendationScanState.completedCycles,
        })
        .from(recommendationScanState)
        .where(eq(recommendationScanState.id, STATE_ID))
        .limit(1);
      const row = rows[0];
      if (!row) {
        // Shouldn't happen post-migration, but be loud if it does — the
        // workflow can't make progress without knowing where to start.
        throw new NonRetryableError(
          "recommendation_scan_state row id='default' missing — drizzle/0116 not applied?"
        );
      }
      return { cursor: row.cursor, completedCycles: row.completedCycles } as const;
    });

    let cursor = initial.cursor;
    let completedCycles = initial.completedCycles;
    let chunksRun = 0;
    let totalRules = 0;
    const totals = { scannedRules: 0, inserted: 0, resolved: 0, failedRules: 0 };
    const slowRules: Array<{ ruleKey: string; ms: number }> = [];

    // ── Step 2: scan chunks ─────────────────────────────────────────
    for (let i = 0; i < chunksPerInvocation; i++) {
      chunksRun++;
      const chunkNum = i + 1;
      const cursorForLog = cursor;

      let result: ChunkResponse;
      try {
        result = await step.do(
          `scan-chunk-${chunkNum}`,
          {
            // Per-step 5min timeout retained — the same single-slow-rule
            // case will still trip it, but now the cron-level work is
            // bounded to chunksPerInvocation × 5min worst case, and the
            // next cron picks up at the same cursor (idempotent — the
            // engine's UPSERT shape tolerates a re-scan of the same rule).
            retries: { limit: 1, delay: "10 seconds", backoff: "exponential" },
            timeout: "5 minutes",
          },
          async (): Promise<ChunkResponse> => {
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
              const text = await response.text().catch(() => "<unreadable>");
              throw new Error(`recommendations-scan 5xx@${cursorForLog}: ${text.slice(0, 200)}`);
            }
            if (!response.ok) {
              const text = await response.text().catch(() => "<unreadable>");
              throw new NonRetryableError(
                `recommendations-scan ${response.status}@${cursorForLog}: ${text.slice(0, 200)}`
              );
            }
            return (await response.json()) as ChunkResponse;
          }
        );
      } catch (err) {
        // Same logging contract as the prior shape: one error_logs row
        // per failed chunk. The standing-failure detector watches for
        // these recurring across days.
        const isNonRetryable = err instanceof NonRetryableError;
        await logError(this.env.DB, {
          source: SOURCE,
          message: isNonRetryable
            ? "chunk threw NonRetryableError (4xx); aborting this invocation"
            : "chunk exhausted retries (5xx / timeout); aborting this invocation",
          error: err,
          sessionId: event.instanceId,
          context: {
            cursor: cursorForLog,
            chunkInInvocation: chunkNum,
            chunksRun,
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
          context: { cursor: cursorForLog, chunkInInvocation: chunkNum },
        });
        break;
      }
      totals.scannedRules += d.scannedRules ?? 0;
      totals.inserted += d.inserted ?? 0;
      totals.resolved += d.resolved ?? 0;
      totals.failedRules += d.failedRules ?? 0;
      if (typeof d.totalRules === "number") totalRules = d.totalRules;

      // REL3.A4.2 — surface slow rules. The whole reason chunk 12 was
      // failing daily is that one rule grew past 5min. Log at WARN so
      // operators can see WHICH rule needs to be optimized, without
      // failing the workflow.
      if (d.ruleTimings) {
        for (const [ruleKey, ms] of Object.entries(d.ruleTimings)) {
          if (ms >= SLOW_RULE_THRESHOLD_MS) {
            slowRules.push({ ruleKey, ms });
          }
        }
      }

      // Advance cursor. If we just finished the last chunk of the
      // cycle, wrap to 0 and bump completedCycles. Break out so we
      // don't waste a chunk re-scanning rules we just finished.
      const next = d.nextCursor ?? cursor;
      if (!d.more) {
        cursor = 0;
        completedCycles++;
        break;
      }
      cursor = next;
    }

    // Emit one WARN row per slow rule detected this invocation — used
    // by the standing-failure detector to surface chronic offenders
    // and as a hint for the operator to profile that rule.
    for (const { ruleKey, ms } of slowRules) {
      await logError(this.env.DB, {
        level: "warn",
        source: `${SOURCE}:slow-rule`,
        message: `rule ${ruleKey} took ${ms}ms (>${SLOW_RULE_THRESHOLD_MS}ms)`,
        sessionId: event.instanceId,
        context: { ruleKey, ms, threshold: SLOW_RULE_THRESHOLD_MS },
      });
    }

    // ── Step 3: persist cursor ──────────────────────────────────────
    // Wrapped in step.do so a transient D1 hiccup doesn't lose all the
    // chunks we just successfully ran. Idempotent: re-running with the
    // same values is a no-op.
    const now = new Date();
    await step.do("persist-cursor", async () => {
      // Only set cycleStartedAt if we're at the top of a fresh cycle
      // (cursor=0 AND we processed any chunks this run).
      const isFreshCycle = cursor === 0 && chunksRun > 0;
      await db
        .update(recommendationScanState)
        .set({
          cursor,
          lastRunAt: now,
          lastRunChunks: chunksRun,
          completedCycles,
          updatedAt: now,
          ...(isFreshCycle ? { cycleStartedAt: now } : {}),
        })
        .where(eq(recommendationScanState.id, STATE_ID));
    });

    // ── Step 4: verify-remeasure (OPE-77, best-effort) ──────────────
    // Re-measure acted items whose verify snapshot is due. Independent of the
    // scan above and never fails the workflow: the step swallows its own errors
    // and returns a status object so a verify hiccup can't abort the sweep.
    const verifyResult = await step.do("verify-remeasure", async () => {
      // Flat numeric/boolean shape only — Workflow step return values must be
      // Serializable (a nested Record<string, unknown> from the JSON body is not).
      try {
        const url = `${this.env.MAIN_APP_URL}/api/admin/recommendations/verify`;
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
        if (!response.ok) {
          await logError(this.env.DB, {
            level: "warn",
            source: `${SOURCE}:verify`,
            message: `verify-remeasure returned ${response.status} (non-fatal)`,
            sessionId: event.instanceId,
          });
          return { ok: false, status: response.status, remeasured: 0, improved: 0, noMovement: 0 };
        }
        const body = (await response.json().catch(() => null)) as {
          remeasured?: number;
          improved?: number;
          noMovement?: number;
        } | null;
        return {
          ok: true,
          status: response.status,
          remeasured: Number(body?.remeasured ?? 0),
          improved: Number(body?.improved ?? 0),
          noMovement: Number(body?.noMovement ?? 0),
        };
      } catch (err) {
        await logError(this.env.DB, {
          level: "warn",
          source: `${SOURCE}:verify`,
          message: "verify-remeasure step errored (non-fatal)",
          error: err,
          sessionId: event.instanceId,
        });
        return { ok: false, status: 0, remeasured: 0, improved: 0, noMovement: 0 };
      }
    });

    return {
      verify: verifyResult,
      chunksRun,
      cursorAfter: cursor,
      totalRules,
      completedCycles,
      slowRuleCount: slowRules.length,
      ...totals,
    };
  }
}

// Exported for unit-test access to the threshold constant.
export const __test = {
  SLOW_RULE_THRESHOLD_MS,
  DEFAULT_CHUNKS_PER_INVOCATION,
};
