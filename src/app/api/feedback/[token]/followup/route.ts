export const dynamic = "force-dynamic";
/**
 * POST /api/feedback/[token]/followup — handle the follow-up form
 * submission for `wrong_intent` and `needs_fixing` paths. Consumes the
 * token, writes the sender_feedback row with the form-collected
 * intended_intent / free_text, and (for wrong_intent) fans out a
 * sender_feedback intent_feedback row so the D.1 dashboard reflects
 * the corrected intent.
 *
 * Body: form-urlencoded `v`, `intendedIntent`, `freeText`.
 *
 * No CSRF token because the token in the URL IS the auth and is
 * one-time-use; a CSRF attacker would need the raw token already.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { consumeToken } from "@/lib/feedback-tokens";
import {
  inboundEmails,
  inboundEmailSenderFeedback,
  inboundEmailIntentFeedback,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { isKnownScannerUaServer } from "@/lib/scanner-ua";

const VALID_VALUES = new Set(["wrong_intent", "needs_fixing"]);

const VALID_INTENTS = new Set([
  "new_event",
  "source_suggestion",
  "correction",
  "claim_request",
  "vendor_inquiry",
  "support",
  "press",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const form = await request.formData();
  const value = String(form.get("v") || "");
  const intendedIntent = String(form.get("intendedIntent") || "");
  const freeText = String(form.get("freeText") || "").slice(0, 1000);

  if (!VALID_VALUES.has(value)) {
    return NextResponse.json({ error: "invalid v" }, { status: 400 });
  }
  if (value === "wrong_intent" && !VALID_INTENTS.has(intendedIntent)) {
    return NextResponse.json(
      { error: "intendedIntent required and must be a valid intent" },
      { status: 400 }
    );
  }
  if (value === "needs_fixing" && !freeText) {
    return NextResponse.json({ error: "freeText required" }, { status: 400 });
  }

  const hdrs = await headers();
  const ua = hdrs.get("user-agent") || "";
  const ip = hdrs.get("cf-connecting-ip") || hdrs.get("x-forwarded-for") || null;

  const db = getCloudflareDb();

  // Scanner-click on a follow-up POST is nonsensical (scanners don't
  // submit forms) — but defensive: consume the token without writing
  // feedback, mirroring the GET path.
  if (isKnownScannerUaServer(ua)) {
    await consumeToken(db, token).catch(() => null);
    return NextResponse.redirect(new URL("/feedback/thanks", request.url));
  }

  const meta = await consumeToken(db, token);
  if (!meta) {
    return NextResponse.json({ error: "token expired, already used, or unknown" }, { status: 410 });
  }

  const now = new Date();
  await db.insert(inboundEmailSenderFeedback).values({
    id: crypto.randomUUID(),
    inboundEmailId: meta.inboundEmailId,
    feedbackToken: token,
    feedbackMoment: meta.feedbackMoment,
    feedbackValue: value,
    intendedIntent: value === "wrong_intent" ? intendedIntent : null,
    freeText: freeText || null,
    resultingEventId: meta.resultingEventId,
    submittedAt: now,
    submitterIp: ip ? ip.slice(0, 64) : null,
    submitterUserAgent: ua ? ua.slice(0, 200) : null,
  });

  // Fan out into the intent feedback substrate when the sender named a
  // specific intended_intent. Sender feedback is the highest-trust
  // signal per spec §D.3 — admin labels age, sender ground truth doesn't.
  if (value === "wrong_intent") {
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
        correctedIntent: intendedIntent,
        classifierVersion: inboundRows[0].classifierVersion,
        adminNote: freeText || null,
        createdBy: null,
        createdAt: now,
      });
    }
  }

  // Redirect to a friendly confirmation page. Reuses the main /feedback
  // landing-page UX without burning another token.
  return NextResponse.redirect(new URL("/feedback/thanks", request.url));
}
