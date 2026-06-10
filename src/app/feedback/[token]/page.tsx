/**
 * Public sender-feedback landing page (Phase D.3). Server Component —
 * consumes the signed token, records the feedback row, and renders a
 * one-time confirmation. No auth: the token IS the authentication.
 *
 * URL shape (embedded in receipt + approval-notification emails):
 *   /feedback/<token>?v=<value>
 *
 * Valid `v` values per spec §D.3.4:
 *   correct        — receipt "yes, submit my event"
 *   wrong_intent   — receipt "I meant something else" (redirects to
 *                    the follow-up form at /feedback/<token>/followup)
 *   cancel         — receipt "cancel — don't add this" (destructive;
 *                    transitions any PENDING resulting event to
 *                    CANCELLED_BY_SENDER lifecycle status)
 *   looks_good     — approval "looks good"
 *   needs_fixing   — approval "something needs fixing" (redirects to
 *                    follow-up form)
 *
 * Scanner-click handling (spec §Q8): the route handler at
 * /api/feedback/[token] does the UA filter + token consume. This page
 * just calls that handler server-side and renders the result.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { consumeToken, verifyTokenForRead } from "@/lib/feedback-tokens";
import {
  inboundEmailSenderFeedback,
  inboundEmailIntentFeedback,
  inboundEmails,
  events,
} from "@/lib/db/schema";
import { isKnownScannerUaServer } from "@/lib/scanner-ua";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";

const VALID_VALUES = new Set(["correct", "wrong_intent", "cancel", "looks_good", "needs_fixing"]);

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ v?: string }>;
}

export default async function FeedbackPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { v: value } = await searchParams;

  if (!value || !VALID_VALUES.has(value)) {
    return (
      <ErrorCard
        title="Invalid feedback link"
        body="This link is missing a feedback value or has an unknown one. Please reply to the original email if you wanted to share something."
      />
    );
  }

  // Forms that send the user to /followup don't burn the token here —
  // we hand off to the form route, which uses verifyTokenForRead +
  // consumes the token at POST time.
  if (value === "wrong_intent" || value === "needs_fixing") {
    const verified = await verifyTokenForRead(getCloudflareDb(), token);
    if (!verified) {
      return (
        <ErrorCard
          title="Link expired or already used"
          body="This feedback link has either been used already or is older than 60 days. Please reply to the original email if you have more to share."
        />
      );
    }
    redirect(`/feedback/${encodeURIComponent(token)}/followup?v=${value}`);
  }

  const hdrs = await headers();
  const ua = hdrs.get("user-agent") || "";
  const ip = hdrs.get("cf-connecting-ip") || hdrs.get("x-forwarded-for") || null;

  const db = getCloudflareDb();

  // Scanner-click handling (spec §Q8): consume the token (so a real
  // user click can't burn it later) but do NOT write a sender_feedback
  // row. Returns the "we got it" landing page with a hidden marker so
  // admin can audit scanner-driven consumes via inbound_email_feedback_tokens
  // (used_at set, but no matching sender_feedback row).
  if (isKnownScannerUaServer(ua)) {
    // Best-effort consume; ignore failure (already-used = no-op).
    await consumeToken(db, token).catch(() => null);
    return <ConfirmCard title="Thanks" body="Your response has been recorded." />;
  }

  const meta = await consumeToken(db, token);
  if (!meta) {
    return (
      <ErrorCard
        title="Link already used or expired"
        body="It looks like this feedback link has already been clicked, or it's older than 60 days. Each link works once — if you have more to share, please reply to the original email."
      />
    );
  }

  // Destructive path: 'cancel' on a receipt-moment token transitions the
  // resulting event (if any, and if still PENDING) to a CANCELLED state.
  // We don't introduce a new lifecycle value — reuse the existing
  // status='REJECTED' with a sender-driven reason so the existing
  // admin filters surface it cleanly.
  let cancelled = false;
  if (value === "cancel" && meta.feedbackMoment === "receipt") {
    if (meta.resultingEventId) {
      // Only cancel if still PENDING — protect against canceling an
      // already-approved event.
      const eventRows = await db
        .select({ id: events.id, status: events.status })
        .from(events)
        .where(eq(events.id, meta.resultingEventId))
        .limit(1);
      if (eventRows.length === 1 && eventRows[0].status === "PENDING") {
        await db
          .update(events)
          .set({ status: "REJECTED", updatedAt: new Date() })
          .where(eq(events.id, meta.resultingEventId));
        cancelled = true;
      }
    }
  }

  const now = new Date();
  await db.insert(inboundEmailSenderFeedback).values({
    id: crypto.randomUUID(),
    inboundEmailId: meta.inboundEmailId,
    feedbackToken: token,
    feedbackMoment: meta.feedbackMoment,
    feedbackValue: value,
    intendedIntent: null,
    freeText: null,
    resultingEventId: meta.resultingEventId,
    submittedAt: now,
    submitterIp: ip ? ip.slice(0, 64) : null,
    submitterUserAgent: ua ? ua.slice(0, 200) : null,
  });

  // Intent-relevant signals fan out into inbound_email_intent_feedback
  // so the D.1 dashboard reflects sender ground-truth alongside admin
  // labels. `correct` and `looks_good` are positive (corrected =
  // original). `cancel` is treated as a "the classifier got it wrong
  // OR I changed my mind" signal — we don't know which, so we don't
  // write an intent_feedback row for it.
  if (value === "correct" || value === "looks_good") {
    const inboundRows = await db
      .select({
        classifiedIntent: inboundEmails.classifiedIntent,
        classifierVersion: inboundEmails.classifierVersion,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, meta.inboundEmailId))
      .limit(1);
    if (inboundRows.length === 1 && inboundRows[0].classifiedIntent) {
      await db.insert(inboundEmailIntentFeedback).values({
        id: crypto.randomUUID(),
        inboundEmailId: meta.inboundEmailId,
        feedbackSource: "sender_feedback",
        originalIntent: inboundRows[0].classifiedIntent,
        correctedIntent: inboundRows[0].classifiedIntent,
        classifierVersion: inboundRows[0].classifierVersion,
        adminNote: null,
        createdBy: null,
        createdAt: now,
      });
    }
  }

  if (cancelled) {
    return (
      <ConfirmCard
        title="Done — your submission has been cancelled."
        body="The event will not be published. Thanks for letting us know."
      />
    );
  }
  if (value === "cancel") {
    return (
      <ConfirmCard
        title="Got it"
        body="We've recorded that you didn't mean to submit this. (No event was active to cancel — either it was already removed or never went live.)"
      />
    );
  }
  return (
    <ConfirmCard
      title="Thanks for the feedback!"
      body={
        value === "looks_good"
          ? "Glad the listing looks right. If anything changes, just reply to the original email."
          : "We'll use this to improve how we handle future submissions."
      }
    />
  );
}

function ConfirmCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="mt-3 text-muted-foreground">{body}</p>
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/" className="text-royal hover:underline">
            ← Back to Meet Me at the Fair
          </Link>
        </p>
      </div>
    </div>
  );
}

function ErrorCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="rounded-lg border border-red-200 bg-red-50 p-8">
        <h1 className="text-xl font-semibold text-red-900">{title}</h1>
        <p className="mt-3 text-red-800">{body}</p>
        <p className="mt-6 text-sm text-red-700">
          <Link href="/" className="hover:underline">
            ← Back to Meet Me at the Fair
          </Link>
        </p>
      </div>
    </div>
  );
}
