/**
 * GET /api/admin/inbound-emails — list recent inbound emails for the
 * /admin/inbound-emails DLQ view.
 *
 * Filters via query string:
 *   - status: comma-separated subset of received|processing|replied|forwarded|failed
 *   - intent: single value (submit|correction|...)
 *   - sinceHours: cutoff window (default 168 = 7 days)
 *   - limit: cap, max 500
 *
 * The page itself is at src/app/admin/inbound-emails/page.tsx.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails, events } from "@/lib/db/schema";
import { desc, eq, gte, inArray, and, type SQL } from "drizzle-orm";

/** Window after received_at within which a resulting event is considered
 *  to have come from this inbound. Workflow typically completes in <30s
 *  for submit-intent emails; 10 min is generous enough to cover retries. */
const EVENT_LOOKUP_WINDOW_SECONDS = 600;

export const runtime = "edge";

const ALLOWED_STATUSES = ["received", "processing", "replied", "forwarded", "failed"] as const;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const statusParam = params.get("status");
  const intent = params.get("intent");
  const sinceHours = Math.min(Math.max(parseInt(params.get("sinceHours") || "168", 10), 1), 720);
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "200", 10), 1), 500);

  const conditions: SQL[] = [];
  const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000);
  conditions.push(gte(inboundEmails.receivedAt, cutoff));
  if (statusParam) {
    const statuses = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof ALLOWED_STATUSES)[number] =>
        (ALLOWED_STATUSES as readonly string[]).includes(s)
      );
    if (statuses.length > 0) {
      conditions.push(inArray(inboundEmails.status, statuses));
    }
  }
  if (intent) {
    conditions.push(eq(inboundEmails.intent, intent));
  }

  const db = getCloudflareDb();
  const rows = await db
    .select({
      id: inboundEmails.id,
      receivedAt: inboundEmails.receivedAt,
      fromAddress: inboundEmails.fromAddress,
      toAddress: inboundEmails.toAddress,
      subject: inboundEmails.subject,
      intent: inboundEmails.intent,
      status: inboundEmails.status,
      workflowInstanceId: inboundEmails.workflowInstanceId,
      error: inboundEmails.error,
      parsedUrl: inboundEmails.parsedUrl,
      attachmentCount: inboundEmails.attachmentCount,
      messageId: inboundEmails.messageId,
    })
    .from(inboundEmails)
    .where(and(...conditions))
    .orderBy(desc(inboundEmails.receivedAt))
    .limit(limit);

  // Resulting-event lookup: for each inbound row that has a parsed URL,
  // find the event (if any) that the workflow created from this submission.
  // Match on events.source_url AND a time window around received_at —
  // protects against false matches when admin manually re-imports the same
  // URL months later. One batch query covers all rows; JS post-process maps.
  const urlsToLookup = Array.from(
    new Set(rows.map((r) => r.parsedUrl).filter((u): u is string => typeof u === "string"))
  );
  const eventsBySourceUrl = new Map<
    string,
    { id: string; slug: string; name: string; createdAt: Date }[]
  >();
  if (urlsToLookup.length > 0) {
    const eventRows = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        sourceUrl: events.sourceUrl,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(inArray(events.sourceUrl, urlsToLookup));
    for (const e of eventRows) {
      if (!e.sourceUrl || !e.createdAt) continue;
      const list = eventsBySourceUrl.get(e.sourceUrl) ?? [];
      list.push({ id: e.id, slug: e.slug, name: e.name, createdAt: e.createdAt });
      eventsBySourceUrl.set(e.sourceUrl, list);
    }
  }

  return NextResponse.json(
    rows.map((r) => {
      const receivedTs = r.receivedAt instanceof Date ? r.receivedAt.getTime() / 1000 : 0;
      const candidates = r.parsedUrl ? (eventsBySourceUrl.get(r.parsedUrl) ?? []) : [];
      const match =
        candidates
          .filter((e) => {
            const eTs = e.createdAt.getTime() / 1000;
            return eTs >= receivedTs && eTs <= receivedTs + EVENT_LOOKUP_WINDOW_SECONDS;
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
      return {
        ...r,
        receivedAt: r.receivedAt instanceof Date ? r.receivedAt.toISOString() : r.receivedAt,
        resultingEvent: match ? { id: match.id, slug: match.slug, name: match.name } : null,
      };
    })
  );
}
