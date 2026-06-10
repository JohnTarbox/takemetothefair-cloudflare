export const dynamic = "force-dynamic";
/**
 * GET /api/admin/inbound-emails/classifier-stats/weekly?weeks=12
 *
 * Phase D.1 §3g — weekly classifier accuracy trend. Companion endpoint
 * to ../route.ts (which returns a single rolling-window snapshot).
 *
 * Returns one bucket per ISO week back to `weeks` ago. Each bucket
 * carries per-classifier_version totals + disagreement counts, so the
 * dashboard can render a per-version line chart over time.
 *
 * Bucketing: Monday-anchored UTC weeks. Computed in JS rather than via
 * SQLite's `strftime('%W', ...)` so the boundary handling is identical
 * to the dashboard's display logic (and we avoid the SQLite quirk where
 * `%W` returns ISO weeks but `%w` returns Sunday-based weekday).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails, inboundEmailIntentFeedback } from "@/lib/db/schema";
import { and, gte, isNotNull, ne, sql } from "drizzle-orm";

const DEFAULT_WEEKS = 12;
const MAX_WEEKS = 52;
const MS_PER_WEEK = 7 * 86400 * 1000;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const weeksRaw = parseInt(url.searchParams.get("weeks") || "", 10);
  const weeks =
    Number.isFinite(weeksRaw) && weeksRaw > 0 ? Math.min(weeksRaw, MAX_WEEKS) : DEFAULT_WEEKS;

  // Window: this Monday at 00:00 UTC minus (weeks - 1) full weeks.
  // Going back `weeks` weeks INCLUSIVE of the current partial week gives
  // a clean 12-bucket chart on a default request.
  const now = new Date();
  const thisMondayUtc = mondayUtcStart(now);
  const windowStart = new Date(thisMondayUtc.getTime() - (weeks - 1) * MS_PER_WEEK);

  const db = getCloudflareDb();

  // Pull all rows in the window — classified inbound emails plus the
  // disagreement feedback set. Volumes are bounded enough that scanning
  // and bucketing in JS is cheaper than per-week SQL (and avoids the
  // strftime quirk noted above).
  const inbounds = await db
    .select({
      classifiedAt: inboundEmails.classifiedAt,
      version: inboundEmails.classifierVersion,
      id: inboundEmails.id,
    })
    .from(inboundEmails)
    .where(
      and(gte(inboundEmails.classifiedAt, windowStart), isNotNull(inboundEmails.classifierVersion))
    );

  const feedback = await db
    .select({
      createdAt: inboundEmailIntentFeedback.createdAt,
      version: inboundEmailIntentFeedback.classifierVersion,
      inboundEmailId: inboundEmailIntentFeedback.inboundEmailId,
    })
    .from(inboundEmailIntentFeedback)
    .where(
      and(
        gte(inboundEmailIntentFeedback.createdAt, windowStart),
        sql`${inboundEmailIntentFeedback.feedbackSource} IN ('admin_reroute', 'sender_feedback')`,
        ne(inboundEmailIntentFeedback.correctedIntent, inboundEmailIntentFeedback.originalIntent)
      )
    );

  // Build per-version-per-week aggregates.
  // Key: `${version}${weekIndex}` (0 = oldest bucket, weeks-1 = current).
  const totalsByKey = new Map<string, number>();
  const disagreementsByKey = new Map<string, Set<string>>();
  const versionsSeen = new Set<string>();

  function weekIndexOf(d: Date | null): number | null {
    if (!d) return null;
    const monday = mondayUtcStart(d);
    const idx = Math.floor((monday.getTime() - windowStart.getTime()) / MS_PER_WEEK);
    if (idx < 0 || idx >= weeks) return null;
    return idx;
  }

  for (const row of inbounds) {
    if (!row.version) continue;
    const idx = weekIndexOf(row.classifiedAt);
    if (idx === null) continue;
    versionsSeen.add(row.version);
    const k = `${row.version}${idx}`;
    totalsByKey.set(k, (totalsByKey.get(k) ?? 0) + 1);
  }
  for (const row of feedback) {
    if (!row.version) continue;
    const idx = weekIndexOf(row.createdAt);
    if (idx === null) continue;
    versionsSeen.add(row.version);
    const k = `${row.version}${idx}`;
    if (!disagreementsByKey.has(k)) disagreementsByKey.set(k, new Set());
    disagreementsByKey.get(k)!.add(row.inboundEmailId);
  }

  // Pivot to one row per (version, week) with accuracy computed.
  interface Bucket {
    weekStart: string; // ISO date for that Monday
    weekIndex: number;
    classifierVersion: string;
    total: number;
    disagreements: number;
    accuracyPct: number | null;
  }
  const buckets: Bucket[] = [];
  for (const version of versionsSeen) {
    for (let i = 0; i < weeks; i++) {
      const k = `${version}${i}`;
      const total = totalsByKey.get(k) ?? 0;
      const disagreements = disagreementsByKey.get(k)?.size ?? 0;
      const right = Math.max(0, total - disagreements);
      const accuracyPct = total > 0 ? Math.round((right / total) * 1000) / 10 : null;
      const weekStart = new Date(windowStart.getTime() + i * MS_PER_WEEK)
        .toISOString()
        .slice(0, 10);
      buckets.push({
        weekStart,
        weekIndex: i,
        classifierVersion: version,
        total,
        disagreements,
        accuracyPct,
      });
    }
  }

  // Top 5 disagreement intent pairs across the whole window. The base
  // /classifier-stats endpoint returns this for a single window too,
  // but rebuilding it here saves the client a second round-trip.
  const matrixRows = await db
    .select({
      original: inboundEmailIntentFeedback.originalIntent,
      corrected: inboundEmailIntentFeedback.correctedIntent,
      n: sql<number>`COUNT(*)`,
    })
    .from(inboundEmailIntentFeedback)
    .where(
      and(
        gte(inboundEmailIntentFeedback.createdAt, windowStart),
        sql`${inboundEmailIntentFeedback.feedbackSource} IN ('admin_reroute', 'sender_feedback')`,
        ne(inboundEmailIntentFeedback.correctedIntent, inboundEmailIntentFeedback.originalIntent)
      )
    )
    .groupBy(inboundEmailIntentFeedback.originalIntent, inboundEmailIntentFeedback.correctedIntent)
    .orderBy(sql`COUNT(*) DESC`);

  return NextResponse.json({
    windowWeeks: weeks,
    windowStart: windowStart.toISOString(),
    buckets,
    versions: [...versionsSeen],
    topDisagreements: matrixRows.slice(0, 5).map((r) => ({
      originalIntent: r.original,
      correctedIntent: r.corrected,
      n: Number(r.n),
    })),
    disagreementMatrix: matrixRows.map((r) => ({
      originalIntent: r.original,
      correctedIntent: r.corrected,
      n: Number(r.n),
    })),
  });
}

/**
 * Monday-anchored UTC week start for a given instant. ISO 8601 weeks
 * use Monday as the first day; we match that. Returns a new Date set
 * to 00:00:00.000 UTC on the Monday of that week.
 */
function mondayUtcStart(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offsetDays = day === 0 ? 6 : day - 1; // distance back to Monday
  const monday = new Date(d.getTime() - offsetDays * 86400 * 1000);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}
