/**
 * MCP-side mirror of src/lib/approval-notification.ts.
 *
 * The two files share intent + behavior but reference different drizzle
 * schema modules (mcp-server has its own re-export shim of
 * @takemetothefair/db-schema). Keep them in sync when touching either.
 *
 * Used by mcp-server/src/tools/admin.ts's update_event_status tool to
 * fire the "your submission was approved" email on non-APPROVED →
 * APPROVED transitions for submitter-attributed events.
 */

import { eq, and, isNull } from "drizzle-orm";
import { events, inboundEmails } from "./schema.js";
import type { Db } from "./db.js";
import { issueToken } from "./feedback-tokens.js";

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

function buildText(
  eventName: string,
  eventUrl: string,
  feedback: { looksGoodUrl: string; needsFixingUrl: string } | null
): string {
  const base = `Good news — ${eventName} has been approved and is now live on Meet Me at the Fair.

See the live listing: ${eventUrl}

We've reviewed and approved your submission. Some details may have been adjusted during review; please check the listing and reply to this thread if anything needs correction.`;

  const widget = feedback
    ? `

Does this listing look right?
  ✅ Looks good: ${feedback.looksGoodUrl}
  ✏️ Something needs fixing: ${feedback.needsFixingUrl}`
    : "";

  return `${base}${widget}

Thanks for helping us keep the directory current.

${SIGN_OFF}`;
}

function buildHtml(
  eventName: string,
  eventUrl: string,
  feedback: { looksGoodUrl: string; needsFixingUrl: string } | null
): string {
  const text = buildText(eventName, eventUrl, feedback);
  return `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

export interface NotifyApprovalEnv {
  EMAIL_JOBS?: Queue<unknown>;
}

export type NotifyApprovalOutcome =
  | "sent"
  | "skipped:no-suggester-email"
  | "skipped:not-approved"
  | "skipped:already-notified"
  | "skipped:not-found"
  | "error:queue-missing";

export interface NotifyApprovalResult {
  outcome: NotifyApprovalOutcome;
}

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

  // Phase D.3: issue an approval-moment feedback token if there's an
  // inbound_email this approval traces back to. Best-effort.
  let feedback: { looksGoodUrl: string; needsFixingUrl: string } | null = null;
  try {
    const inboundRows = await db
      .select({ id: inboundEmails.id })
      .from(inboundEmails)
      .where(eq(inboundEmails.resultingEventId, eventId))
      .limit(1);
    if (inboundRows.length === 1) {
      const token = await issueToken(db, {
        inboundEmailId: inboundRows[0].id,
        feedbackMoment: "approval",
        resultingEventId: eventId,
      });
      const base = `${PUBLIC_HOST}/feedback/${encodeURIComponent(token)}`;
      feedback = {
        looksGoodUrl: `${base}?v=looks_good`,
        needsFixingUrl: `${base}?v=needs_fixing`,
      };
    }
  } catch {
    // Intentional swallow: see comment in main-app twin.
  }

  const msg: EmailJobMessage = {
    to: e.suggesterEmail,
    subject: `${SUBJECT_PREFIX} ${e.name}`.slice(0, 200),
    text: buildText(e.name, eventUrl, feedback),
    html: buildHtml(e.name, eventUrl, feedback),
    source: "email:submission-approved",
  };

  await env.EMAIL_JOBS.send(msg);

  await db
    .update(events)
    .set({ approvalNotifiedAt: new Date() })
    .where(and(eq(events.id, eventId), isNull(events.approvalNotifiedAt)));

  return { outcome: "sent" };
}
