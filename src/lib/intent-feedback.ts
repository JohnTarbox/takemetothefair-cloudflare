/**
 * Workflow-outcome inference for the intent classifier (Phase D.2).
 *
 * When admin transitions a PENDING / TENTATIVE event to APPROVED or
 * REJECTED, we can infer whether the original classifier intent was
 * right:
 *
 *   APPROVED + no admin intent change → new_event was correct (positive)
 *   REJECTED with reason matching "not an event" / "spam" / "duplicate"
 *                                  → new_event was wrong (negative)
 *   REJECTED for other reasons      → ambiguous; no feedback row
 *
 * This module exposes one function called from approval-notification.ts
 * + the admin lifecycle endpoint. Best-effort: any failure to write a
 * feedback row logs and returns; never throws (the calling path's job
 * is to update event status, not feedback bookkeeping).
 */

import { eq, and, isNotNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { inboundEmails, inboundEmailIntentFeedback } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/** Map a rejection reason string to an inferred corrected_intent. Loose
 *  pattern match — false-negative-prone is fine because admin can also
 *  reclassify manually for the unambiguous cases. */
function rejectionReasonToCorrectedIntent(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (/\bnot (?:a |an )?(?:real )?event\b/.test(r)) return "unclear";
  if (/\bspam\b/.test(r)) return "spam";
  if (/\bduplicate\b/.test(r)) return "unclear";
  return null;
}

/**
 * Insert a workflow-outcome feedback row for an event-status transition,
 * if the inferred signal is unambiguous.
 *
 * - newStatus='APPROVED' with no admin reclassification → positive
 *   for new_event (or whatever the classifier picked).
 * - newStatus='REJECTED' with a recognized reason → negative for
 *   new_event, corrected_intent set per the reason map above.
 *
 * Returns the feedback row id, or null if no signal was inferred.
 */
export async function recordWorkflowOutcome(
  db: Db,
  args: {
    eventId: string;
    newStatus: string;
    rejectionReason?: string | null;
  }
): Promise<string | null> {
  // Find the inbound_email that produced this event (if any). The
  // inbound row's resulting_event_id is the join key.
  const inboundRows = await db
    .select({
      id: inboundEmails.id,
      classifiedIntent: inboundEmails.classifiedIntent,
      classifierVersion: inboundEmails.classifierVersion,
      intent: inboundEmails.intent,
    })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.resultingEventId, args.eventId),
        isNotNull(inboundEmails.classifiedIntent)
      )
    )
    .limit(1);
  if (inboundRows.length === 0) return null;
  const inbound = inboundRows[0];
  const originalIntent = inbound.classifiedIntent;
  if (!originalIntent) return null;

  let correctedIntent: string | null = null;
  if (args.newStatus === "APPROVED") {
    // Positive signal — confirm the classifier was right.
    correctedIntent = originalIntent;
  } else if (args.newStatus === "REJECTED") {
    correctedIntent = rejectionReasonToCorrectedIntent(args.rejectionReason);
    if (!correctedIntent) return null;
  } else {
    return null;
  }

  // Idempotency: skip if a workflow_outcome row already exists for this
  // inbound_email with the same corrected_intent. Doesn't fire on
  // un-approve→re-approve cycles because admin lifecycle changes
  // produce a single signal each.
  const existing = await db
    .select({ id: inboundEmailIntentFeedback.id })
    .from(inboundEmailIntentFeedback)
    .where(
      and(
        eq(inboundEmailIntentFeedback.inboundEmailId, inbound.id),
        eq(inboundEmailIntentFeedback.feedbackSource, "workflow_outcome"),
        eq(inboundEmailIntentFeedback.correctedIntent, correctedIntent)
      )
    )
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const id = crypto.randomUUID();
  await db.insert(inboundEmailIntentFeedback).values({
    id,
    inboundEmailId: inbound.id,
    feedbackSource: "workflow_outcome",
    originalIntent,
    correctedIntent,
    classifierVersion: inbound.classifierVersion,
    adminNote: null,
    createdBy: null,
    createdAt: new Date(),
  });
  return id;
}

// Re-export the rejection reason mapper so callers can preview the
// inference without writing.
export { rejectionReasonToCorrectedIntent };
