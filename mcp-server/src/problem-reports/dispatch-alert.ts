/**
 * UR1 C2 (2026-06-04) — HIGH-severity problem-report alert dispatcher.
 *
 * Pushes a Slack + email notification to the same technical channel the
 * page-error canary uses (SLACK_WEBHOOK_URL_TECHNICAL +
 * ALERT_EMAIL_TECHNICAL via env.EMAIL_JOBS). Identical fan-out pattern
 * to page-error-canary.ts; kept as a sibling rather than refactoring
 * both to a shared helper because the two callers compose the body
 * differently (canary = burst summary, problem-report = user-submitted
 * report + correlation context).
 *
 * Caller-side contract: passed as the `dispatchHighAlert` arg to
 * `intakeProblemReport`. Failure must NOT throw — the intake path
 * swallows alert errors so a Slack outage can't block a report landing
 * in D1.
 */

import { logError } from "../logger.js";

const SOURCE = "mcp:problem-reports:dispatch-alert";
const SLACK_BUDGET_MS = 5_000;

/**
 * Structural subset of env fields this dispatcher uses. Both the full
 * Worker `Env` and `HandlerEnv` (email-handlers/types.ts, after the
 * 2026-06-04 K2-rewire extension) satisfy this shape. Keeping the
 * dispatcher decoupled from the larger Env interface means future
 * callers (e.g. a future cron-driven escalation re-check) don't have
 * to widen their own env types just to call this.
 */
export interface DispatchAlertEnv {
  DB: D1Database;
  SLACK_WEBHOOK_URL_TECHNICAL?: string;
  ALERT_EMAIL_TECHNICAL?: string;
  EMAIL_JOBS?: Queue;
}

export interface HighAlertContext {
  reportId: string;
  correlatedErrorCount: number;
  bySource: Array<{ source: string | null; count: number }>;
  /** Optional excerpt of the user's body for triage context. */
  bodyExcerpt?: string | null;
  /** Source of the report — "web" or "email". Helps operators decide
   *  whether to reply to the reporter directly. */
  reportSource?: "web" | "email";
}

export async function dispatchHighProblemReportAlert(
  env: DispatchAlertEnv,
  ctx: HighAlertContext
): Promise<void> {
  const adminLink = `https://meetmeatthefair.com/admin/problem-reports/${ctx.reportId}`;
  const sourceLines = ctx.bySource
    .slice(0, 5)
    .map((s) => `• \`${s.source ?? "<null>"}\` — ${s.count}`);
  const sourceList =
    ctx.bySource.length > 0 ? `\n*Top error sources*:\n${sourceLines.join("\n")}` : "";
  const bodyHint = ctx.bodyExcerpt
    ? `\n*User said*: _"${ctx.bodyExcerpt.slice(0, 240).replace(/[\n\r]+/g, " ")}"_`
    : "";

  const slackText =
    `🔴 *Problem report HIGH* — co-occurs with ${ctx.correlatedErrorCount} errors in the −30m/+5m window` +
    `${bodyHint}${sourceList}\n<${adminLink}|Open report ${ctx.reportId.slice(0, 8)}…>`;

  // Slack fan-out.
  const slackUrl = env.SLACK_WEBHOOK_URL_TECHNICAL;
  if (slackUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SLACK_BUDGET_MS);
    try {
      const res = await fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: slackText }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "<empty>");
        await logError(env.DB, {
          source: SOURCE,
          message: `Slack dispatch failed: ${res.status}: ${body.slice(0, 200)}`,
          context: { reportId: ctx.reportId },
        }).catch(() => {});
      }
    } catch (err) {
      await logError(env.DB, {
        source: SOURCE,
        message: "Slack dispatch threw",
        error: err,
        context: { reportId: ctx.reportId },
      }).catch(() => {});
    } finally {
      clearTimeout(timeout);
    }
  }

  // Email fan-out.
  const alertEmail = env.ALERT_EMAIL_TECHNICAL;
  if (alertEmail && env.EMAIL_JOBS) {
    const subject = `🔴 Problem report HIGH (${ctx.correlatedErrorCount} co-occurring errors)`;
    const textBody =
      `A user submitted a problem report that co-occurs with ${ctx.correlatedErrorCount} errors ` +
      `in the −30m/+5m window — likely a real outage.\n\n` +
      (ctx.bodyExcerpt ? `User said:\n  ${ctx.bodyExcerpt.slice(0, 500)}\n\n` : "") +
      (ctx.bySource.length > 0
        ? `Top error sources:\n${ctx.bySource
            .slice(0, 5)
            .map((s) => `  ${s.source ?? "<null>"} — ${s.count}`)
            .join("\n")}\n\n`
        : "") +
      `Open the report: ${adminLink}\n`;
    const htmlBody =
      `<p>🔴 <strong>Problem report HIGH</strong> — ${ctx.correlatedErrorCount} co-occurring errors</p>` +
      (ctx.bodyExcerpt
        ? `<p>User said: <em>${escapeHtml(ctx.bodyExcerpt.slice(0, 500))}</em></p>`
        : "") +
      (ctx.bySource.length > 0
        ? `<p>Top error sources:</p><ul>${ctx.bySource
            .slice(0, 5)
            .map((s) => `<li><code>${escapeHtml(s.source ?? "<null>")}</code> — ${s.count}</li>`)
            .join("")}</ul>`
        : "") +
      `<p><a href="${adminLink}">Open report</a></p>`;
    try {
      await env.EMAIL_JOBS.send({
        to: alertEmail,
        subject,
        text: textBody,
        html: htmlBody,
        source: "problem-report:high",
      });
    } catch (err) {
      await logError(env.DB, {
        source: SOURCE,
        message: "Email dispatch threw",
        error: err,
        context: { reportId: ctx.reportId },
      }).catch(() => {});
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
