export const dynamic = "force-dynamic";
/**
 * POST /api/admin/inbound-emails/[id]/mark-correct — admin actively
 * labels a low-confidence row as correctly classified. Writes a row to
 * inbound_email_intent_feedback with feedback_source='admin_label',
 * corrected_intent = classified_intent (i.e., confirming the classifier
 * was right despite low confidence). Spec §D.1.
 *
 * No body required. Idempotent — repeated calls insert duplicate rows,
 * which the dashboard de-duplicates per (inbound_email_id, feedback_source).
 */

import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { inboundEmails, inboundEmailIntentFeedback, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const POST = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ db, session, params }) => {
  const { id } = params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const rows = await db
    .select({
      classifiedIntent: inboundEmails.classifiedIntent,
      intent: inboundEmails.intent,
      classifierVersion: inboundEmails.classifierVersion,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, id))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: "inbound_email not found" }, { status: 404 });
  }
  const row = rows[0];
  // No classifier ran on this row — there's nothing to confirm.
  if (!row.classifiedIntent) {
    return NextResponse.json(
      { error: "row has no classifier_intent; cannot mark correct" },
      { status: 400 }
    );
  }

  const now = new Date();
  await db.insert(inboundEmailIntentFeedback).values({
    id: crypto.randomUUID(),
    inboundEmailId: id,
    feedbackSource: "admin_label",
    originalIntent: row.classifiedIntent,
    correctedIntent: row.classifiedIntent, // confirming the classifier was right
    classifierVersion: row.classifierVersion,
    adminNote: null,
    createdBy: session.user.id,
    createdAt: now,
  });

  await db.insert(adminActions).values({
    action: "inbound_email.mark_correct",
    actorUserId: session.user.id,
    targetType: "inbound_email",
    targetId: id,
    payloadJson: JSON.stringify({ confirmedIntent: row.classifiedIntent }),
    createdAt: now,
  });

  return NextResponse.json({ ok: true });
});
