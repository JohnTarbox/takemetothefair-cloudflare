/**
 * OPE-832 — turn a defect described in an email into something the defect
 * queue can see.
 *
 * The gap this closes, measured over 180 days in prod (2026-09-07): three
 * distinct customer defect reports, four emails, all `intent=support`, and
 * ZERO `problem_reports` rows. The only two email-sourced rows that exist are
 * both from 2026-06-04 — a Cloudflare Email Routing address-verification
 * notice and a `"testinr"` smoke test, i.e. the setup traffic for the
 * `report@`/`feedback@` handler on the day it shipped. So the email→report
 * path has never regressed. It has never once received a real customer report,
 * because it fires on RECIPIENT ADDRESS and nobody writes to those addresses.
 *
 * ── Why a CANDIDATE and not a defect ───────────────────────────────────
 *
 * `kind = "defect_candidate"`, which OPE-769 already made a first-class idea.
 * `list_problem_reports` defaults to `kind: "defect"`, so a candidate cannot
 * inflate the defect count this ticket exists to make trustworthy; and its
 * summary reports `open_other_kinds`, so a candidate cannot vanish either. An
 * operator promotes it. Auto-filing straight into `defect` would repeat
 * OPE-769's own defect — a table holding two kinds of work and reading as N
 * open bugs when it is not.
 *
 * ── Idempotency ────────────────────────────────────────────────────────
 *
 * Workflow steps retry and email is redelivered at-least-once. Keyed on
 * `inbound_email_id`: if ANY problem_reports row already cites this email,
 * nothing is written. That also means the `report@` path wins — it runs in the
 * handler and creates a real `defect` row first, so this never double-files on
 * top of it (the exact shape OPE-769 was filed about).
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { problemReports } from "../schema.js";
import { intakeProblemReport } from "../problem-reports/intake.js";
import { detectDefectReport } from "./defect-language.js";
import type { Db } from "../db.js";

/** What happened, so the caller can record it. A bare boolean would make
 *  "detector never ran" and "detector ran and found nothing" identical — the
 *  OPE-540 lesson, and the reason this probe can exist at all. */
export type DefectCandidateOutcome =
  | { status: "created"; reportId: string; matched: string[] }
  | { status: "no-defect-language" }
  | { status: "already-reported" }
  | { status: "intent-skipped" };

/**
 * Intents this does NOT examine.
 *
 * `problem_report` already creates a real row in its own handler — running
 * here too would double-file. `spam` is quarantined and its body is hostile
 * input. Everything else IS examined, deliberately: the three measured
 * specimens arrived at four different addresses (notify@, hello@, support@,
 * submit@) under two intents, so an allow-list of "the intents bugs arrive
 * under" would be a guess at a distribution of three.
 */
const SKIP_INTENTS: ReadonlySet<string> = new Set(["problem_report", "spam"]);

export async function recordDefectCandidate(
  db: Db,
  args: {
    inboundEmailId: string;
    intent: string;
    subject: string | null;
    bodyText: string | null;
    fromAddress: string | null;
  }
): Promise<DefectCandidateOutcome> {
  if (SKIP_INTENTS.has(args.intent)) return { status: "intent-skipped" };

  const detection = detectDefectReport(`${args.subject ?? ""}\n${args.bodyText ?? ""}`);
  if (!detection.isDefect) return { status: "no-defect-language" };

  const existing = await db
    .select({ id: problemReports.id })
    .from(problemReports)
    .where(
      and(
        isNotNull(problemReports.inboundEmailId),
        eq(problemReports.inboundEmailId, args.inboundEmailId)
      )
    )
    .limit(1);
  if (existing.length > 0) return { status: "already-reported" };

  const angle = args.fromAddress?.match(/<([^>]+)>/);
  const reporterEmail = angle?.[1] ?? args.fromAddress ?? null;

  const result = await intakeProblemReport(db, {
    // The matched phrases lead, so a reviewer can judge the call without
    // reopening the email — and so a phrase that turns out to produce junk is
    // identifiable by name rather than by guesswork.
    body:
      `[auto-detected from email — matched: ${detection.matched.join(", ")}]\n\n` +
      (args.bodyText ?? args.subject ?? "(no body)"),
    source: "email",
    reporterEmail,
    inboundEmailId: args.inboundEmailId,
    kind: "defect_candidate",
  });

  return { status: "created", reportId: result.id, matched: detection.matched };
}
