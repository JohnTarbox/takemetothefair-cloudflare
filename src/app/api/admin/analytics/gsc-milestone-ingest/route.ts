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
import { getCloudflareDb } from "@/lib/cloudflare";
import { parseGscMilestoneEmail } from "@/lib/gsc-milestone-email";
import { ingestGscMilestone } from "@/lib/gsc-milestone-ingest";

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

  const milestone = parseGscMilestoneEmail({ subject, body, emailDate });
  if (!milestone) {
    return NextResponse.json(
      {
        success: false,
        error: "not_a_milestone",
        message:
          "Subject did not match a GSC milestone ('reaching <N> clicks in <D> days') or the email date was unparseable.",
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
