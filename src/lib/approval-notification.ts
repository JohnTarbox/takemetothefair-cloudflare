/**
 * Idempotent "your submission was approved" email notification.
 *
 * Fires once per event when admin transitions a submitter-attributed
 * event from PENDING/TENTATIVE → APPROVED. Gated on:
 *   - events.suggester_email IS NOT NULL (we need somewhere to send)
 *   - events.status = 'APPROVED' (only on actual approval, not edits)
 *   - events.approval_notified_at IS NULL (idempotency — won't re-send
 *     if admin un-approves then re-approves to fix a typo)
 *
 * Pushes one EmailJobMessage onto EMAIL_JOBS; the MCP-worker consumer
 * drains and sends via env.EMAIL.send(). Sets approval_notified_at
 * AFTER the queue push so a queue-bound failure doesn't burn the
 * idempotency window.
 *
 * Call this AFTER you've already written the new status to D1.
 * Read-only with respect to the events.status column; only updates
 * approval_notified_at.
 */

import { eq, and, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { events } from "@/lib/db/schema";
import { recordWorkflowOutcome } from "@/lib/intent-feedback";

type Db = DrizzleD1Database<typeof schema>;

interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

const SUBJECT_PREFIX = "Your submission is live:";
const SIGN_OFF = "— Meet Me at the Fair";
const PUBLIC_HOST = "https://meetmeatthefair.com";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildText(eventName: string, eventUrl: string): string {
  return `Good news — ${eventName} has been approved and is now live on Meet Me at the Fair.

See the live listing: ${eventUrl}

We've reviewed and approved your submission. Some details may have been adjusted during review; please check the listing and reply to this thread if anything needs correction.

Thanks for helping us keep the directory current.

${SIGN_OFF}`;
}

function buildHtml(eventName: string, eventUrl: string): string {
  const text = buildText(eventName, eventUrl);
  // Escape user-controlled values; convert blank lines to <p> and single
  // newlines to <br>. Same pattern as email-reply-builder.ts.
  return `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

export interface NotifyApprovalEnv {
  EMAIL_JOBS?: Queue<unknown>;
}

export interface NotifyApprovalResult {
  /** "sent": queue push succeeded + approval_notified_at set.
   *  "skipped:<reason>": one of the gate conditions wasn't met.
   *  "error:queue-missing": EMAIL_JOBS binding absent (dev/misconfig). */
  outcome:
    | "sent"
    | "skipped:no-suggester-email"
    | "skipped:not-approved"
    | "skipped:already-notified"
    | "skipped:not-found"
    | "error:queue-missing";
}

/**
 * Check conditions + enqueue the approval notification if applicable.
 *
 * Designed to be called from any approval-transition site (admin UI
 * PATCH, MCP tools, bulk endpoints) after the status update is
 * persisted. Returns an outcome string so callers can log without
 * inferring from side effects.
 */
export async function notifyApprovalIfNeeded(
  db: Db,
  env: NotifyApprovalEnv,
  eventId: string
): Promise<NotifyApprovalResult> {
  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      status: events.status,
      suggesterEmail: events.suggesterEmail,
      approvalNotifiedAt: events.approvalNotifiedAt,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (rows.length === 0) return { outcome: "skipped:not-found" };
  const e = rows[0];

  if (!e.suggesterEmail) return { outcome: "skipped:no-suggester-email" };
  if (e.status !== "APPROVED") return { outcome: "skipped:not-approved" };
  if (e.approvalNotifiedAt !== null) return { outcome: "skipped:already-notified" };

  if (!env.EMAIL_JOBS) return { outcome: "error:queue-missing" };

  const eventUrl = `${PUBLIC_HOST}/events/${e.slug}`;
  const msg: EmailJobMessage = {
    to: e.suggesterEmail,
    subject: `${SUBJECT_PREFIX} ${e.name}`.slice(0, 200),
    text: buildText(e.name, eventUrl),
    html: buildHtml(e.name, eventUrl),
    source: "email:submission-approved",
  };

  await env.EMAIL_JOBS.send(msg);

  // Marker AFTER queue push so a queue failure doesn't burn the
  // idempotency window. Race window: if the queue push succeeds but the
  // UPDATE fails, a second approval transition could re-send. Both
  // operations are cheap and reliable; risk is acceptable.
  await db
    .update(events)
    .set({ approvalNotifiedAt: new Date() })
    .where(and(eq(events.id, eventId), isNull(events.approvalNotifiedAt)));

  // Phase D.2: record the implicit positive signal for the classifier
  // that originally routed this submission. Best-effort — any error
  // is swallowed so the approval flow stays clean (the feedback loop
  // is observability, not user-facing).
  try {
    await recordWorkflowOutcome(db, { eventId, newStatus: "APPROVED" });
  } catch {
    // Intentional swallow — see comment above.
  }

  return { outcome: "sent" };
}
