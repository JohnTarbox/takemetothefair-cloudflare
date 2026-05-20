/**
 * GET /api/admin/inbound-emails/classifier-stats?days=30
 *
 * Returns rolling-window classifier accuracy metrics for the Phase D.1
 * dashboard. Three sections:
 *
 *   accuracy:       per-classifier_version accuracy + uncorrected count
 *   disagreements:  (original_intent × corrected_intent) frequency table
 *                   for admin_reroute + sender_feedback rows
 *   sources:        feedback source mix (admin_reroute / admin_label /
 *                   workflow_outcome / sender_feedback / user_reply)
 *
 * Window is configurable via ?days=N (default 30, max 365). Accuracy
 * excludes feedback rows where corrected_intent === original_intent
 * (confirmations — not disagreements). Spec §D.4.1.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails, inboundEmailIntentFeedback } from "@/lib/db/schema";
import { and, gte, isNotNull, ne, sql } from "drizzle-orm";

export const runtime = "edge";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const daysRaw = parseInt(url.searchParams.get("days") || "", 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, MAX_DAYS) : DEFAULT_DAYS;
  const sinceMs = Date.now() - days * 86400 * 1000;
  const sinceDate = new Date(sinceMs);

  const db = getCloudflareDb();

  // Accuracy by classifier_version. Calculation:
  //   accuracy = 1 - (admin_reroute + sender_feedback disagreements
  //                   for this row) / total classifications
  // We treat any row that has at least one disagreement feedback as
  // "corrected"; multiple feedback rows on the same inbound don't
  // inflate the count.
  const classifications = await db
    .select({
      version: inboundEmails.classifierVersion,
      total: sql<number>`COUNT(*)`,
    })
    .from(inboundEmails)
    .where(
      and(gte(inboundEmails.classifiedAt, sinceDate), isNotNull(inboundEmails.classifierVersion))
    )
    .groupBy(inboundEmails.classifierVersion);

  // Distinct inbound_email_ids that received a disagreement feedback
  // (admin_reroute OR sender_feedback) where corrected != original.
  const disagreementRows = await db
    .select({
      version: inboundEmailIntentFeedback.classifierVersion,
      inboundEmailId: inboundEmailIntentFeedback.inboundEmailId,
    })
    .from(inboundEmailIntentFeedback)
    .where(
      and(
        gte(inboundEmailIntentFeedback.createdAt, sinceDate),
        sql`${inboundEmailIntentFeedback.feedbackSource} IN ('admin_reroute', 'sender_feedback')`,
        ne(inboundEmailIntentFeedback.correctedIntent, inboundEmailIntentFeedback.originalIntent)
      )
    );
  const disagreementsByVersion = new Map<string, Set<string>>();
  for (const r of disagreementRows) {
    if (!r.version) continue;
    if (!disagreementsByVersion.has(r.version)) disagreementsByVersion.set(r.version, new Set());
    disagreementsByVersion.get(r.version)!.add(r.inboundEmailId);
  }

  const accuracy = classifications.map((c) => {
    const wrong = disagreementsByVersion.get(c.version ?? "")?.size ?? 0;
    const total = Number(c.total ?? 0);
    const right = Math.max(0, total - wrong);
    const pct = total > 0 ? right / total : null;
    return {
      classifierVersion: c.version,
      total,
      uncorrected: right,
      disagreements: wrong,
      accuracyPct: pct === null ? null : Math.round(pct * 1000) / 10,
    };
  });

  // Disagreement matrix (original × corrected) for admin_reroute +
  // sender_feedback only. Confirmations (admin_label, or any feedback
  // where corrected === original) excluded.
  const matrixRows = await db
    .select({
      original: inboundEmailIntentFeedback.originalIntent,
      corrected: inboundEmailIntentFeedback.correctedIntent,
      n: sql<number>`COUNT(*)`,
    })
    .from(inboundEmailIntentFeedback)
    .where(
      and(
        gte(inboundEmailIntentFeedback.createdAt, sinceDate),
        sql`${inboundEmailIntentFeedback.feedbackSource} IN ('admin_reroute', 'sender_feedback')`,
        ne(inboundEmailIntentFeedback.correctedIntent, inboundEmailIntentFeedback.originalIntent)
      )
    )
    .groupBy(inboundEmailIntentFeedback.originalIntent, inboundEmailIntentFeedback.correctedIntent)
    .orderBy(sql`COUNT(*) DESC`);

  const sourceRows = await db
    .select({
      source: inboundEmailIntentFeedback.feedbackSource,
      n: sql<number>`COUNT(*)`,
    })
    .from(inboundEmailIntentFeedback)
    .where(gte(inboundEmailIntentFeedback.createdAt, sinceDate))
    .groupBy(inboundEmailIntentFeedback.feedbackSource);

  return NextResponse.json({
    windowDays: days,
    since: sinceDate.toISOString(),
    accuracy,
    disagreements: matrixRows.map((r) => ({
      originalIntent: r.original,
      correctedIntent: r.corrected,
      n: Number(r.n),
    })),
    sources: sourceRows.map((r) => ({
      feedbackSource: r.source,
      n: Number(r.n),
    })),
  });
}
