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
 * Multi-event landing-page note (analyst D1 Phase 1, 2026-05-29). When
 * the extractor pulled multiple events off one URL but the submit
 * pipeline only ingested the first as PENDING, surface a paragraph so
 * the sender knows we noticed the others and offers the path to fix.
 * Phase 2 (separate PR) will fan out into N PENDING events.
 *
 * Returns empty string when count <= 0 — caller can append
 * unconditionally without a wrapping guard.
 */
function buildAdditionalEventsNote(params: ReplyParams): string {
  const count =
    typeof params.additionalEventsDetected === "number" ? params.additionalEventsDetected : 0;
  if (count <= 0) return "";
  const names = Array.isArray(params.additionalEventNames)
    ? (params.additionalEventNames as string[])
    : [];
  const sample = names
    .slice(0, 3)
    .map((n) => `"${n}"`)
    .join(", ");
  const tail =
    sample.length > 0
      ? ` We noticed these additional events on the same page: ${sample}${names.length > 3 ? `, and ${names.length - 3} more` : ""}.`
      : "";
  return `\n\nWe also detected ${count} other event${count === 1 ? "" : "s"} on that page that we didn't ingest this time.${tail} If you'd like the others added too, please reply with their names and dates and we'll line them up.`;
}

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

  const baseText = renderText(kind, params);
  // Phase D.3 widget: append a "was this what you wanted?" block when
  // the workflow's send-reply step issued a receipt-moment token.
  const text = appendReceiptWidget(baseText, params);
  const html = `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;

  return {
    to,
    subject: replySubject,
    text,
    html,
    source: `email:${kind}`,
  };
}

function appendReceiptWidget(baseText: string, params: ReplyParams): string {
  const correctUrl = params.feedbackCorrectUrl as string | undefined;
  const wrongIntentUrl = params.feedbackWrongIntentUrl as string | undefined;
  const cancelUrl = params.feedbackCancelUrl as string | undefined;
  if (!correctUrl && !wrongIntentUrl && !cancelUrl) return baseText;

  const widget = [
    "",
    "Was this what you wanted?",
    correctUrl ? `  ✅ Yes, that's right: ${correctUrl}` : null,
    wrongIntentUrl ? `  ✏️ I meant something else: ${wrongIntentUrl}` : null,
    cancelUrl ? `  ❌ Cancel — don't add this: ${cancelUrl}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  // Insert before the SIGN_OFF if present so the sign-off stays last.
  // Splice on the last occurrence of "\n— " (the dash starting the
  // sign-off line) — robust against future template tweaks.
  const splitIdx = baseText.lastIndexOf("\n— ");
  if (splitIdx === -1) {
    return `${baseText}\n${widget}`;
  }
  return `${baseText.slice(0, splitIdx)}\n${widget}${baseText.slice(splitIdx)}`;
}

function renderText(kind: Exclude<ReplyKind, null>, params: ReplyParams): string {
  switch (kind) {
    case "ok": {
      const eventName = (params.eventName as string | undefined) ?? "your event";
      const hasAttachments = !!params.hasAttachments;
      const attachmentNote = hasAttachments
        ? "\n\nNote: We don't process attachments yet. If your message had images or PDFs, please keep them handy in case our team has questions during review."
        : "";
      const multiEventNote = buildAdditionalEventsNote(params);
      return `Thanks for submitting "${eventName}" to Meet Me at the Fair!

Your submission is being reviewed by our team. Approved events typically appear within 24 hours.${attachmentNote}${multiEventNote}

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    // B3: MEDIUM confidence — extractor pulled an event but flagged
    // some critical fields as uncertain. PENDING event was still created
    // (admin reviews like normal), but the sender is invited to reply
    // with the unsure fields to speed up the review.
    case "ok-medium": {
      const eventName = (params.eventName as string | undefined) ?? "your event";
      const unsure = (params.unsureFields as string | undefined) ?? "";
      const unsureClause = unsure ? ` — specifically the ${unsure}` : "";
      const correctionFormUrl = (params.correctionFormUrl as string | undefined) ?? "";
      // When the extracted name itself is in the unsure list, don't quote
      // it — quoting a dubious value back to the sender reads as "we're
      // confident about this name even though we just said it's unsure"
      // (e.g. AI extracted "Next Business Meeting" from a club homepage
      // and listed event_name among the unsure fields, the original
      // template said: "Thanks for submitting \"Next Business Meeting\"
      // … the event name was hard to pin down"). Generic phrasing avoids
      // the contradiction.
      const nameIsUnsure = isNameUnsure(unsure);
      const opening = nameIsUnsure
        ? `Thanks for emailing Meet Me at the Fair about your event submission!`
        : `Thanks for submitting "${eventName}" to Meet Me at the Fair!`;
      // PR-N B4: when a correction form URL is available, prefer it to
      // the "reply with corrections" prose ask — much higher completion
      // rate than free-text-reply correction.
      const correctionAsk = correctionFormUrl
        ? `If you can correct anything we missed, use this form (link valid for 30 days):\n${correctionFormUrl}`
        : `If you can reply with anything we missed, it'll speed up the review.`;
      return `${opening}

We've captured your submission and our team will review it within 24 hours. A couple of details were a little hard to pin down${unsureClause}. ${correctionAsk}

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    // B1: multi-URL submission. Workflow fanned out across N URLs and
    // produced one reply summarizing all outcomes. resultsText is a
    // newline-joined block built by the workflow (kept as a single
    // string in replyParams to satisfy the JSON-serializable-primitive
    // constraint on HandlerResult.replyParams).
    case "ok-multi": {
      const count = Number(params.eventCount ?? 0);
      const resultsText = (params.resultsText as string | undefined) ?? "";
      const overflowed = !!params.overflowed;
      const overflowLine = overflowed
        ? "\n\nNote: your email had more than 10 URLs — we processed the first 10. Reply with the remaining URLs and we'll handle those too."
        : "";
      return `Thanks for submitting ${count} event${count === 1 ? "" : "s"} to Meet Me at the Fair!

${resultsText}

Our team will review pending submissions within 24 hours.${overflowLine}

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    // B3: LOW confidence — extractor pulled a minimal event but most
    // critical fields are uncertain. PENDING event still created, but
    // the sender's reply (with date + venue + name) is essentially
    // required for the event to be useful.
    case "ok-low": {
      const eventName = (params.eventName as string | undefined) ?? "your event";
      const unsure = (params.unsureFields as string | undefined) ?? "";
      const unsureClause = unsure ? ` (we're not yet confident about: ${unsure})` : "";
      const correctionFormUrl = (params.correctionFormUrl as string | undefined) ?? "";
      // Same rule as ok-medium: don't quote a name we flagged as unsure.
      const nameIsUnsure = isNameUnsure(unsure);
      const opening = nameIsUnsure
        ? `Thanks for emailing Meet Me at the Fair!`
        : `Thanks for emailing Meet Me at the Fair about "${eventName}"!`;
      // PR-N B4: prefer the form when available. The prose ask stays as
      // the fallback (workflow may fail to issue the token; the reply
      // still needs to ask for corrections in that case).
      const correctionAsk = correctionFormUrl
        ? `Please fill in the missing details using this form (link valid for 30 days):\n${correctionFormUrl}`
        : `Please reply with the date(s), venue name + address, and a short description of the event.`;
      return `${opening}

We captured the basics${unsureClause}, but to make sure your event shows up correctly we need a few more details. ${correctionAsk} Our team will review and publish once we have what we need.

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    // Cohort 2 (2026-06-01) MEDIUM-confidence dedup hit. New PENDING
    // event was created and tagged with possible_duplicate_of, but the
    // sender is told it MAY be a duplicate. The operator's admin queue
    // surfaces the candidate inline with a one-click merge button —
    // they confirm or reject. Distinct from "already-exists" (HIGH
    // dedup: no new event created) and from "ok-medium" (low field
    // confidence, non-duplicate).
    case "ok-medium-dup": {
      const eventName = (params.eventName as string | undefined) ?? "your event";
      const candidateName = (params.candidateName as string | undefined) ?? "an existing event";
      const candidateUrl = (params.candidateUrl as string | undefined) ?? "";
      const candidateLine = candidateUrl
        ? `  ${candidateName}\n  ${candidateUrl}`
        : `  ${candidateName}`;
      return `Thanks for submitting "${eventName}" to Meet Me at the Fair!

We've captured your submission, but it might be the same event as one already on our site:

${candidateLine}

Our team will compare them within 24 hours and either merge yours with the existing listing or publish it as a separate event. If you're sure they're different, just reply with a quick note (different organizer, different town, etc.) and we'll publish yours separately.

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
    case "no-url-prose-failed": {
      // Used when classifier said free_text (no URL) AND extractor ran on
      // the body AND the result didn't carry enough fields. The user did
      // include details; the soft ask is "give us the structured fields"
      // rather than the dismissive "please send a link." See GH #244.
      const hasAttachments = !!params.hasAttachments;
      const attachmentNote = hasAttachments
        ? "We don't process attachments yet, so any details in a flyer image or PDF would need to be in the email body or a link.\n\n"
        : "";
      return `Thanks for emailing Meet Me at the Fair!

We received your event details but couldn't reliably pull out the key fields. Could you reply with the event name, start date, and location (venue or address)? If there's an official page for the event — a Facebook event, ticket site, or organizer page — a link works too.

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
    case "sweep-exceeded": {
      const url = (params.url as string | undefined) ?? "the page you linked";
      return `Thanks for emailing Meet Me at the Fair!

We tried multiple times to process your submission for ${url} but ran into the same problem each time. Our team has been notified and will review it manually — you don't need to do anything. If you have a different link with clearer event details (date, location, hours), feel free to reply with it.

${SUPPORT_LINE}

${SIGN_OFF}`;
    }
    case "submission-approved": {
      // Fires when admin transitions a submitter-attributed event from
      // PENDING/TENTATIVE → APPROVED. Generic phrasing about edits ("some
      // details may have been adjusted during review") covers the common
      // case where admin fixed dates/venue before approving, without
      // committing to specifics.
      const eventName = (params.eventName as string | undefined) ?? "your event";
      const eventUrl = (params.eventUrl as string | undefined) ?? null;
      const urlLine = eventUrl ? `\n\nSee the live listing: ${eventUrl}\n` : "";
      return `Good news — ${eventName} has been approved and is now live on Meet Me at the Fair.${urlLine}

We've reviewed and approved your submission. Some details may have been adjusted during review; please check the listing and reply to this thread if anything needs correction.

Thanks for helping us keep the directory current.

${SIGN_OFF}`;
    }
    case "already-exists": {
      // The dedup endpoint can match by exact source_url OR by name+date
      // similarity ≥0.85 within ±7 days. Reply branches on the matched
      // event's status:
      //  - APPROVED / CONFIRMED / lifecycle-public → show the public URL
      //  - PENDING / REJECTED / TENTATIVE / etc.  → suppress URL (it
      //    would 404 — /events/[slug] gates on isPublicEventStatus).
      //    Sender still gets a clear "already in our system" ack with
      //    the same corrections invitation.
      const eventName = (params.eventName as string | undefined) ?? "this event";
      const eventUrl = (params.eventUrl as string | undefined) ?? null;
      const existingStatus = (params.existingEventStatus as string | undefined) ?? "";
      const isPubliclyVisible = existingStatus === "APPROVED" || existingStatus === "CONFIRMED";
      const urlLine =
        eventUrl && isPubliclyVisible ? `\n\nYou can see our listing here: ${eventUrl}\n` : "";
      const reviewLine = !isPubliclyVisible
        ? "\n\nIt's currently in review and will go live within 24 hours of approval — we'll email you again when it does.\n"
        : "";
      return `Thanks for emailing Meet Me at the Fair!

Good news — we already have ${eventName} in our directory.${urlLine}${reviewLine}

If you noticed something missing or out of date, please reply to this thread with the correction and our team will take a look.

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
    case "source-suggestion-ack": {
      const host = (params.suggestedHost as string | undefined) ?? "";
      const informalUsageCount = Number(params.informalUsageCount ?? 0);
      const tier = (params.tier as string | undefined) ?? "";
      const hostLine = host ? ` (${host})` : "";

      // Tier 1: already registered as an active source via email_source_suggestions.
      if (tier === "registered") {
        return `Thanks for the source suggestion!

We already pull events from ${host || "this source"} — it's on our active discovery list. If you noticed a specific event missing from the site, please reply with the URL and we'll take a look.

${SIGN_OFF}`;
      }

      // Tier 2: informal usage — flagged for admin to formally register.
      if (tier === "informal" || (!tier && informalUsageCount > 0 && host)) {
        return `Thanks for the source suggestion!

We already pull events informally from ${host} — we have ${informalUsageCount} event${informalUsageCount === 1 ? "" : "s"} on the site sourced from there. We've flagged this for our team to formally register the source in our discovery queue.

If you noticed a specific event missing, please reply with the URL and we'll take a look.

${SIGN_OFF}`;
      }

      // Tier 3 (default): fresh suggestion queued for admin review.
      return `Thanks for the source suggestion!

We've added your suggestion${hostLine} to our discovery queue. Our team reviews these regularly and we'll let you know if we start pulling events from it.

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

/**
 * Whether the unsureFields list (a comma-separated string the workflow
 * builds from summarizeUnsureFields) flags the event name as unsure.
 * Matches the label string "event name" that summarizeUnsureFields emits
 * for `name`. Loose match — also catches stray variants ("name", "event
 * title") if those ever get added. Exported for unit tests.
 */
export function isNameUnsure(unsureFields: string): boolean {
  if (!unsureFields) return false;
  return /\bevent name\b|\bname\b|\btitle\b/i.test(unsureFields);
}
