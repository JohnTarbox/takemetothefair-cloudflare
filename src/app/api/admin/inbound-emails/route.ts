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
      replyKind: inboundEmails.replyKind,
      resultingEventId: inboundEmails.resultingEventId,
      // Phase C.1 / D.1 — classifier metadata + admin annotations.
      classifiedIntent: inboundEmails.classifiedIntent,
      classifiedSubIntent: inboundEmails.classifiedSubIntent,
      classifiedConfidence: inboundEmails.classifiedConfidence,
      classifiedRationale: inboundEmails.classifiedRationale,
      classifierVersion: inboundEmails.classifierVersion,
      routingSource: inboundEmails.routingSource,
      flaggedForReview: inboundEmails.flaggedForReview,
      parentEmailId: inboundEmails.parentEmailId,
    })
    .from(inboundEmails)
    .where(and(...conditions))
    .orderBy(desc(inboundEmails.receivedAt))
    .limit(limit);

  // Resulting-event lookup. Two paths:
  // (a) Rows with resulting_event_id populated (post-drizzle/0076) — direct
  //     foreign-key-style lookup. Works for both 'ok' (new event) and
  //     'already-exists' (matched existing event) replyKinds.
  // (b) Historical rows pre-0076 with parsedUrl set — fall back to the
  //     source_url + 10-min-window heuristic. Imperfect for the dedup case
  //     (the matched existing event is OLDER than received_at and falls
  //     outside the window), but right for the 'ok' case which is the
  //     dominant historical path.
  const directEventIds = Array.from(
    new Set(
      rows.map((r) => r.resultingEventId).filter((id): id is string => typeof id === "string")
    )
  );
  const eventById = new Map<string, { id: string; slug: string; name: string }>();
  if (directEventIds.length > 0) {
    const directEvents = await db
      .select({ id: events.id, slug: events.slug, name: events.name })
      .from(events)
      .where(inArray(events.id, directEventIds));
    for (const e of directEvents) eventById.set(e.id, e);
  }

  // Fallback JOIN for historical rows. Only run if any row lacks
  // resultingEventId — saves a query on fresh prod traffic.
  const fallbackUrls = Array.from(
    new Set(
      rows
        .filter((r) => !r.resultingEventId)
        .map((r) => r.parsedUrl)
        .filter((u): u is string => typeof u === "string")
    )
  );
  const eventsBySourceUrl = new Map<
    string,
    { id: string; slug: string; name: string; createdAt: Date }[]
  >();
  if (fallbackUrls.length > 0) {
    const eventRows = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        sourceUrl: events.sourceUrl,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(inArray(events.sourceUrl, fallbackUrls));
    for (const e of eventRows) {
      if (!e.sourceUrl || !e.createdAt) continue;
      const list = eventsBySourceUrl.get(e.sourceUrl) ?? [];
      list.push({ id: e.id, slug: e.slug, name: e.name, createdAt: e.createdAt });
      eventsBySourceUrl.set(e.sourceUrl, list);
    }
  }

  return NextResponse.json(
    rows.map((r) => {
      let resultingEvent: { id: string; slug: string; name: string } | null = null;
      if (r.resultingEventId) {
        const e = eventById.get(r.resultingEventId);
        if (e) resultingEvent = e;
      } else if (r.parsedUrl) {
        // Historical fallback path (see comment above).
        const receivedTs = r.receivedAt instanceof Date ? r.receivedAt.getTime() / 1000 : 0;
        const candidates = eventsBySourceUrl.get(r.parsedUrl) ?? [];
        const match =
          candidates
            .filter((e) => {
              const eTs = e.createdAt.getTime() / 1000;
              return eTs >= receivedTs && eTs <= receivedTs + EVENT_LOOKUP_WINDOW_SECONDS;
            })
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
        if (match) resultingEvent = { id: match.id, slug: match.slug, name: match.name };
      }
      return {
        ...r,
        receivedAt: r.receivedAt instanceof Date ? r.receivedAt.toISOString() : r.receivedAt,
        resultingEvent,
      };
    })
  );
}
