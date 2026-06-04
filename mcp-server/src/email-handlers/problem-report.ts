/**
 * `report@` / `feedback@` handler — UR1 Phase 1 (2026-06-04).
 *
 * Inserts a problem_reports row via the shared intakeProblemReport helper
 * (which also runs error_logs burst-watch correlation and dispatches a
 * HIGH-severity alert if the report co-occurred with an outage).
 *
 * Always acks the sender with `problem-report-ack`.
 */

import { getDb } from "../db.js";
import { intakeProblemReport } from "../problem-reports/intake.js";
import { logError } from "../logger.js";
import type { HandlerFn, HandlerResult } from "./types.js";

const SOURCE = "mcp:email-handler:problem-report";

export const handle: HandlerFn = async (env, ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);

  // Body extraction: use bodyTextExcerpt (the parsed plain-text preview
  // stored in inbound_emails). The original raw HTML isn't persisted —
  // it was processed at the entrypoint and only the excerpt + parsed_url
  // survive. Falls back to subject if the excerpt is empty (rare).
  const rawBody =
    row.bodyTextExcerpt?.trim() ||
    row.subject?.trim() ||
    "(empty body — see inbound_emails row " + row.id + " for raw context)";

  // Reporter email — `fromAddress` is "Name <email>" or "email". Cheap
  // parse: take the angle-bracket content if present, else the whole
  // string.
  const angleMatch = row.fromAddress?.match(/<([^>]+)>/);
  const reporterEmail = angleMatch?.[1] ?? row.fromAddress ?? null;

  try {
    // We don't read the result — severity + correlation are persisted
    // server-side. C2 will use the dispatchHighAlert param below to push
    // to the technical channel on HIGH.
    await intakeProblemReport(db, {
      body: rawBody,
      source: "email",
      reporterEmail,
      // path: emails don't carry the user's page context — null is fine.
      path: null,
      userAgent: null,
      inboundEmailId: row.id,
      // dispatchHighAlert: C2 will wire the real Slack/email dispatcher
      // here. For now (C1) HIGH still gets recorded in the row + visible
      // in the admin page; the channel push is the next commit.
    });

    // Link the inbound_email row to the resulting problem_reports row
    // via existing `resulting_event_id`? No — that column is for events.
    // Add the row id to admin_actions instead for audit visibility.
    // (admin_actions write would require importing the table; skipped
    // here to keep C1 small. Operator can find the report via the
    // inbound_emails id link in the admin queue.)

    return {
      replyKind: "problem-report-ack",
      status: "replied",
      // Stash on the workflow context for downstream logging — the
      // admin queue already shows reply_kind so HIGH-severity reports
      // are visually distinguishable via the admin page's severity badge.
    };
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: `intake failed for inbound ${row.id}`,
      error: err,
      sessionId: ctx.sessionId,
    });
    // Still ack the sender — they did their part. The failed-intake
    // case is visible in error_logs for operator triage.
    return {
      replyKind: "problem-report-ack",
      status: "replied",
    };
  }
};
