/**
 * Auto-reply template builder. Each ReplyKind maps to one template that
 * produces the EmailJobMessage shape the queue consumer expects
 * (queue-consumers.ts -> env.EMAIL.send via Cloudflare Email Sending).
 *
 * Templates are intentionally plain — escape user-controlled strings
 * (subject, eventName, url) and convert text newlines to <p>/<br> for
 * the HTML alternative. No framework, no Markdown, no fancy CSS — keeps
 * the deliverability surface area tight.
 *
 * Senders to rate-limited or `unknown` (catch-all) addresses never see
 * a reply — those paths pass replyKind=null upstream and skip this
 * builder entirely.
 */

import type { ReplyKind, ReplyParams } from "./email-handlers/types.js";

interface EmailJobMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  source: string;
}

const SUPPORT_LINE = "If you didn't mean to email us, you can ignore this message.";
const SIGN_OFF = "— Meet Me at the Fair";

/**
 * Build the outbound auto-reply for `replyKind`. Throws on null kind —
 * the workflow's send-reply step short-circuits before calling.
 */
export function buildReply(
  kind: Exclude<ReplyKind, null>,
  to: string,
  params: ReplyParams = {}
): EmailJobMessage {
  const subjectIn = (params.subject as string | undefined) ?? "";
  const replySubject = `Re: ${subjectIn || "your message"}`.slice(0, 200);

  const text = renderText(kind, params);
  const html = `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;

  return {
    to,
    subject: replySubject,
    text,
    html,
    source: `email:${kind}`,
  };
}

function renderText(kind: Exclude<ReplyKind, null>, params: ReplyParams): string {
  switch (kind) {
    case "ok": {
      const eventName = (params.eventName as string | undefined) ?? "your event";
      const hasAttachments = !!params.hasAttachments;
      const attachmentNote = hasAttachments
        ? "\n\nNote: We don't process attachments yet. If your message had images or PDFs, please keep them handy in case our team has questions during review."
        : "";
      return `Thanks for submitting "${eventName}" to Meet Me at the Fair!

Your submission is being reviewed by our team. Approved events typically appear within 24 hours.${attachmentNote}

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    case "no-url": {
      const hasAttachments = !!params.hasAttachments;
      const attachmentNote = hasAttachments
        ? "We don't process attachments yet, so please include a link rather than a flyer image or PDF.\n\n"
        : "";
      return `Thanks for emailing Meet Me at the Fair!

We couldn't find a link to the event in your message. To submit an event, please reply with a URL to the event's official page (a fair website, ticket page, or social media post all work).

${attachmentNote}${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    case "extract-failed": {
      const url = (params.url as string | undefined) ?? "the page you linked";
      return `Thanks for emailing Meet Me at the Fair!

We couldn't extract event details from ${url}. Our team has been notified and will review it manually. If you have a different link with clearer event details (date, location, hours), feel free to reply with it.

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    case "submit-failed": {
      return `Thanks for emailing Meet Me at the Fair!

We received your event submission but ran into a problem saving it. Our team has been notified and will follow up if needed.

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    case "correction-ack": {
      return `Thanks for letting us know!

We've recorded your correction request and our team will review it shortly. If we have questions, we'll reply directly to this email.

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    case "support-ack": {
      return `Thanks for reaching out to Meet Me at the Fair!

We've received your message and our team will get back to you soon. For event submissions, you can also use submit@meetmeatthefair.com directly.

${SIGN_OFF}`;
    }
    case "press-ack": {
      return `Thanks for your interest in Meet Me at the Fair!

A team member will follow up shortly with media materials. If your inquiry is time-sensitive, please reply with a deadline.

${SIGN_OFF}`;
    }
    case "unsubscribe-ack": {
      return `You've been unsubscribed.

Your email address has been removed from our newsletter. You won't receive further marketing emails from Meet Me at the Fair. (Transactional messages — like replies to event submissions — may still be sent.)

${SIGN_OFF}`;
    }
    case "correction-applied": {
      const note = (params.note as string | undefined) ?? "";
      const noteBlock = note ? `\n\nAdmin note: ${note}\n` : "";
      return `Thanks for the correction!

We've applied your update. The change should be visible on the site within a few minutes.${noteBlock}

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    case "correction-rejected": {
      const note = (params.note as string | undefined) ?? "";
      const noteBlock = note
        ? `\n\nAdmin note: ${note}\n`
        : "\n\nIf you have additional details (a source link, official announcement, etc.), please reply with them and we'll take another look.\n";
      return `Thanks for reaching out about a correction.

After reviewing, we weren't able to apply this change as-is.${noteBlock}

${SIGN_OFF}`;
    }
    case "correction-needs-info": {
      const note = (params.note as string | undefined) ?? "";
      const noteBlock = note
        ? `\n\nWhat we need: ${note}\n`
        : "\n\nCould you reply with a source (official announcement, fair website, etc.)?\n";
      return `Thanks for reaching out about a correction.

We need a bit more information before we can apply the change.${noteBlock}

${SIGN_OFF}`;
    }
    case "press-handled": {
      const note = (params.note as string | undefined) ?? "";
      const noteBlock = note ? `\n\n${note}\n` : "";
      return `Thanks for your interest in Meet Me at the Fair!

Our team has reviewed your inquiry and a member should have followed up directly. If you haven't heard from us within a business day, please reply to this thread.${noteBlock}

${SIGN_OFF}`;
    }
    case "press-needs-info": {
      const note = (params.note as string | undefined) ?? "";
      const noteBlock = note
        ? `\n\nWhat we need: ${note}\n`
        : "\n\nCould you share your outlet, deadline, and the angle you're working on?\n";
      return `Thanks for your interest in Meet Me at the Fair!

We'd love to help with your story. To match you with the right materials, we need a bit more context.${noteBlock}

${SIGN_OFF}`;
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
