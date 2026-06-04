/**
 * Shared problem-report intake (UR1 Phase 1, 2026-06-04).
 *
 * Two callers:
 *   1. mcp-server/src/email-handlers/problem-report.ts (email source).
 *   2. src/app/api/report-problem/route.ts (web form, via the main
 *      app — that route re-implements this same logic against its own
 *      Db instance because they're separate Worker artifacts).
 *
 * The mcp-server version is the canonical one — keeping all severity
 * logic + correlation here means a single audit when thresholds change.
 *
 * What it does:
 *   - Inserts a `problem_reports` row.
 *   - Runs B1's `getErrorLogsBurstWindow` over the (-30m, +5m) window
 *     around `created_at`. If the count >= HIGH_THRESHOLD, marks the
 *     row severity=HIGH and dispatches a Slack/email alert via the
 *     same technical channel the page-error canary uses.
 *
 * Returns the inserted row id + final severity for caller logging.
 */

import { problemReports } from "@takemetothefair/db-schema";
import type { Db } from "../db.js";
import { getErrorLogsBurstWindow } from "../error-logs-burst.js";

/** ≥10 errors in (-30m, +5m) around created_at → escalate HIGH.
 *  Matches the threshold John locked in the UR1 spec. */
export const HIGH_THRESHOLD = 10;

/** Look-back window: 30 minutes before report time. */
export const LOOKBACK_MINUTES = 30;
/** Look-forward window: 5 minutes after report time. Captures the case
 *  where a user reports a brand-new outage that's still spiking. */
export const LOOKAHEAD_MINUTES = 5;

export interface ProblemReportInput {
  body: string;
  source: "web" | "email";
  reporterEmail?: string | null;
  path?: string | null;
  userAgent?: string | null;
  inboundEmailId?: string | null;
}

export interface ProblemReportResult {
  id: string;
  severity: "LOW" | "HIGH";
  correlatedErrorCount: number;
}

export async function intakeProblemReport(
  db: Db,
  input: ProblemReportInput,
  /** Injected so the web-form caller can use a different alert dispatch
   *  if needed. The default (no-op) is fine for the email path because
   *  C2 will swap in the real dispatcher.
   *  Returning void; errors are swallowed by the dispatcher so a Slack
   *  outage doesn't fail the report intake. */
  dispatchHighAlert?: (ctx: {
    reportId: string;
    correlatedErrorCount: number;
    bySource: Array<{ source: string | null; count: number }>;
  }) => Promise<void>
): Promise<ProblemReportResult> {
  const id = crypto.randomUUID();
  const createdAt = new Date();

  // 1. Run correlation BEFORE the insert so we can write the final
  //    severity in one go (saves a follow-up UPDATE).
  const since = new Date(createdAt.getTime() - LOOKBACK_MINUTES * 60_000);
  const until = new Date(createdAt.getTime() + LOOKAHEAD_MINUTES * 60_000);
  let correlatedErrorCount = 0;
  let bySource: Array<{ source: string | null; count: number }> = [];
  try {
    const burst = await getErrorLogsBurstWindow(db, {
      since,
      until,
      // No sourcePattern — we want ALL errors in the window, not just
      // page-fetcher ones. A user reporting a problem during an API
      // outage matters even if no page-level fetcher tripped.
      minCount: HIGH_THRESHOLD,
      topSourcesLimit: 5,
    });
    correlatedErrorCount = burst.totalErrors;
    bySource = burst.bySource;
  } catch {
    // Correlation failure must NOT fail the report intake. Default to
    // LOW severity; operator will see the correlation gap in the admin
    // page (correlated_error_count=0 with a note in the body).
    correlatedErrorCount = 0;
    bySource = [];
  }
  const severity: "LOW" | "HIGH" = correlatedErrorCount >= HIGH_THRESHOLD ? "HIGH" : "LOW";

  // 2. Insert.
  await db.insert(problemReports).values({
    id,
    reporterEmail: input.reporterEmail ?? null,
    body: input.body,
    source: input.source,
    path: input.path ?? null,
    userAgent: input.userAgent ?? null,
    inboundEmailId: input.inboundEmailId ?? null,
    severity,
    correlatedErrorCount,
    createdAt,
  });

  // 3. HIGH escalation — dispatch alert if a dispatcher was provided.
  if (severity === "HIGH" && dispatchHighAlert) {
    try {
      await dispatchHighAlert({
        reportId: id,
        correlatedErrorCount,
        bySource,
      });
    } catch {
      // Alert dispatch failure must NOT fail the intake. Operator
      // sees the HIGH row in the admin page regardless.
    }
  }

  return { id, severity, correlatedErrorCount };
}
