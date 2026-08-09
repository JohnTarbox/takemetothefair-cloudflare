export const dynamic = "force-dynamic";
/**
 * OPE-108 — POST a GSC "click milestone" congrats email (subject + body +
 * received date); parse it and upsert a `gsc_milestone_emails` row so the admin
 * "Search clicks milestones" chart stays current without hand-entered SQL.
 *
 * Auth: admin session OR X-Internal-Key (the MCP `ingest_gsc_milestone_email`
 * tool uses the latter). Idempotent — dedupes on (metric, window_days, threshold).
 *
 * Body: { subject: string, body?: string, email_date: string, note?: string }
 * `email_date` may be ISO (YYYY-MM-DD…), "Jul 6, 2026", or an RFC-2822 date header.
 */
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { parseGscMilestoneEmail } from "@/lib/gsc-milestone-email";
import { ingestGscMilestone } from "@/lib/gsc-milestone-ingest";
import {
  parseGscMonthlyOracleEmail,
  divergence,
  API_DIVERGENCE_ALARM,
  monthBounds,
  type GscMonthlyOracle,
} from "@/lib/gsc-monthly-oracle";
import { gscDailyTotals, gscMonthlyOracle, gscSearchMetrics } from "@/lib/db/schema";
import { and, gte, lt, sql } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { enqueueEmail } from "@/lib/queues/producers";

type PostBody = { subject?: unknown; body?: unknown; email_date?: unknown; note?: unknown };

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: PostBody;
  try {
    payload = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "invalid_json", message: "Body must be valid JSON." },
      { status: 400 }
    );
  }

  const subject = typeof payload.subject === "string" ? payload.subject : "";
  const body = typeof payload.body === "string" ? payload.body : null;
  const emailDate = typeof payload.email_date === "string" ? payload.email_date : "";
  const note = typeof payload.note === "string" ? payload.note : null;

  if (!subject || !emailDate) {
    return NextResponse.json(
      {
        success: false,
        error: "missing_fields",
        message: "Body must include `subject` (string) and `email_date` (string).",
      },
      { status: 400 }
    );
  }

  // OPE-344 — this endpoint is now the single parse authority for BOTH shapes
  // of sc-noreply mail. The worker deliberately does not decide which is which
  // (that would duplicate the regexes across two deploys); it hands over the
  // raw text and each parser returns null for the shape it doesn't own.
  const oracle = parseGscMonthlyOracleEmail({ subject, body, emailDate });
  if (oracle) {
    try {
      return await ingestMonthlyOracle(oracle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { success: false, error: "oracle_failed", message },
        { status: 500 }
      );
    }
  }

  const milestone = parseGscMilestoneEmail({ subject, body, emailDate });
  if (!milestone) {
    return NextResponse.json(
      {
        success: false,
        error: "not_a_milestone",
        message:
          "Subject matched neither a GSC milestone ('reaching <N> clicks in <D> days') nor a monthly Search performance report, or the email date was unparseable.",
      },
      { status: 400 }
    );
  }

  try {
    const db = getCloudflareDb();
    const { inserted, row } = await ingestGscMilestone(db, milestone, { note });
    return NextResponse.json({
      success: true,
      inserted,
      milestone: {
        id: row.id,
        metric: row.metric,
        window_days: row.windowDays,
        threshold: row.threshold,
        reached_date: row.reachedDate,
        email_date: row.emailDate,
      },
      note: inserted
        ? "Milestone recorded."
        : "Threshold already recorded — kept the earliest row (idempotent).",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

/**
 * Store one oracle reading and run the three-way comparison at ingest time.
 *
 * Comparing NOW rather than on read is deliberate: the recorded numbers are
 * what was true when Google spoke, so a later reader sees the actual historical
 * disagreement instead of re-deriving it against data that has since changed.
 */
async function ingestMonthlyOracle(oracle: GscMonthlyOracle) {
  const db = getCloudflareDb();
  // EXCLUSIVE upper bound — see monthBounds. `<= firstOfNextMonth` leaks one
  // extra day and quietly inflates the comparison.
  const { start: monthStart, endExclusive } = monthBounds(oracle.month);

  const [apiRow] = await db
    .select({ clicks: sql<number>`coalesce(sum(${gscDailyTotals.clicks}), 0)` })
    .from(gscDailyTotals)
    .where(and(gte(gscDailyTotals.date, monthStart), lt(gscDailyTotals.date, endExclusive)));

  const [dimRow] = await db
    .select({ clicks: sql<number>`coalesce(sum(${gscSearchMetrics.clicks}), 0)` })
    .from(gscSearchMetrics)
    .where(and(gte(gscSearchMetrics.date, monthStart), lt(gscSearchMetrics.date, endExclusive)));

  const apiClicks = Number(apiRow?.clicks ?? 0);
  const dimensionedClicks = Number(dimRow?.clicks ?? 0);
  const apiDivergence = divergence(apiClicks, oracle.clicks);
  const now = new Date();

  await db
    .insert(gscMonthlyOracle)
    .values({
      month: oracle.month,
      clicks: oracle.clicks,
      impressions: oracle.impressions,
      pagesWithFirstImpressions: oracle.pagesWithFirstImpressions,
      rawClicks: oracle.raw.clicks,
      rawImpressions: oracle.raw.impressions,
      rawPages: oracle.raw.pages,
      emailDate: oracle.emailDate,
      apiClicks,
      dimensionedClicks,
      apiDivergence,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: gscMonthlyOracle.month,
      set: {
        clicks: oracle.clicks,
        impressions: oracle.impressions,
        pagesWithFirstImpressions: oracle.pagesWithFirstImpressions,
        rawClicks: oracle.raw.clicks,
        rawImpressions: oracle.raw.impressions,
        rawPages: oracle.raw.pages,
        emailDate: oracle.emailDate,
        apiClicks,
        dimensionedClicks,
        apiDivergence,
        updatedAt: now,
      },
    });

  // The dimensioned gap is EXPECTED (OPE-345) and is recorded as data, never
  // alarmed on — alarming would cry wolf every single month.
  const alarm = apiDivergence > API_DIVERGENCE_ALARM;
  if (alarm) {
    const msg =
      `GSC ingest disagrees with Google's own ${oracle.month} report: ` +
      `ours ${apiClicks} vs oracle ${oracle.clicks} clicks ` +
      `(${(apiDivergence * 100).toFixed(1)}% divergence). Our API ingest is likely wrong.`;

    await logError(db, { level: "error", source: "gsc:oracle-divergence", message: msg });

    // Alerted directly, NOT left to the standing-failure canary. That canary
    // requires errors on >=3 distinct days before escalating, which suits a
    // daily failure — but this comparison happens once a MONTH, so a real
    // divergence would never reach the threshold and would escalate never.
    const to = (getCloudflareEnv() as unknown as { ALERT_EMAIL_TECHNICAL?: string })
      .ALERT_EMAIL_TECHNICAL;
    if (to) {
      await enqueueEmail({
        to,
        subject: `🔴 GSC ingest diverges from Google's ${oracle.month} report`,
        text: `${msg}\n\nDimensioned store (expected to be low, not an alarm): ${dimensionedClicks}.\n`,
        html: `<p><strong>${msg}</strong></p><p style="color:#666">Dimensioned store (expected to be low, not an alarm): ${dimensionedClicks}.</p>`,
        source: "gsc.oracle-divergence",
      });
    }
  }

  return NextResponse.json({
    success: true,
    kind: "monthly_oracle",
    month: oracle.month,
    oracle: { clicks: oracle.clicks, impressions: oracle.impressions },
    comparison: {
      api_clicks: apiClicks,
      dimensioned_clicks: dimensionedClicks,
      api_divergence: apiDivergence,
      alarmed: alarm,
    },
  });
}
