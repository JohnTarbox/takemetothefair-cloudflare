/**
 * GET /api/admin/inbound-emails/senders — sender-quality summary.
 *
 * Aggregates inbound_emails + events into a per-sender breakdown so the
 * admin can see at a glance who's submitting (volume), what they're
 * producing (events created, approval rate), where (state mix), and
 * whether the operator has annotated them (trust_status from
 * inbound_email_senders).
 *
 * Why two subqueries, not one JOIN: inbound_emails and events have a
 * many-to-many relationship per sender (one email can produce one
 * event, no event on dedup hit, or no event on extract failure). A
 * single LEFT JOIN multiplies row counts via the cartesian product.
 * Compute each aggregate separately and combine.
 *
 * Result shape stable enough to share with the MCP tool (which calls
 * the same underlying drizzle queries). Read-only; trust annotation
 * writes happen via the set_email_sender_trust MCP tool.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails, events, inboundEmailSenders } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export const runtime = "edge";

const NE_STATES = new Set(["ME", "NH", "VT", "MA", "CT", "RI"]);

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "50", 10), 1), 200);

  const db = getCloudflareDb();

  // Inbound aggregates per sender (only submit intent — other intents
  // aren't "submitters" in the sense this report measures).
  const inboundRows = await db
    .select({
      fromAddress: inboundEmails.fromAddress,
      total: sql<number>`COUNT(*)`,
      replied: sql<number>`SUM(CASE WHEN ${inboundEmails.status} = 'replied' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${inboundEmails.status} = 'failed' THEN 1 ELSE 0 END)`,
      firstSeen: sql<number>`MIN(${inboundEmails.receivedAt})`,
      lastSeen: sql<number>`MAX(${inboundEmails.receivedAt})`,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.intent, "submit"))
    .groupBy(inboundEmails.fromAddress);

  // Event aggregates per sender (only events originating from the
  // email-submission source so we don't conflate community/vendor form
  // submissions sharing an email).
  const eventRows = await db
    .select({
      suggesterEmail: events.suggesterEmail,
      eventsCreated: sql<number>`COUNT(*)`,
      approved: sql<number>`SUM(CASE WHEN ${events.status} = 'APPROVED' THEN 1 ELSE 0 END)`,
      pending: sql<number>`SUM(CASE WHEN ${events.status} = 'PENDING' THEN 1 ELSE 0 END)`,
      rejected: sql<number>`SUM(CASE WHEN ${events.status} = 'REJECTED' THEN 1 ELSE 0 END)`,
    })
    .from(events)
    .where(sql`${events.sourceName} = 'email-submission' AND ${events.suggesterEmail} IS NOT NULL`)
    .groupBy(events.suggesterEmail);

  // State-code breakdown per sender. Out-of-area = non-NE majority.
  const stateRows = await db
    .select({
      suggesterEmail: events.suggesterEmail,
      stateCode: events.stateCode,
      n: sql<number>`COUNT(*)`,
    })
    .from(events)
    .where(
      sql`${events.sourceName} = 'email-submission' AND ${events.suggesterEmail} IS NOT NULL AND ${events.stateCode} IS NOT NULL`
    )
    .groupBy(events.suggesterEmail, events.stateCode);

  // Trust annotations. LEFT JOIN against the aggregates — most senders
  // don't have an annotation row yet.
  const trustRows = await db
    .select({
      email: inboundEmailSenders.email,
      trustStatus: inboundEmailSenders.trustStatus,
      notes: inboundEmailSenders.notes,
    })
    .from(inboundEmailSenders);

  // Build per-sender index maps so the combine step is O(n).
  const eventByEmail = new Map(eventRows.map((r) => [r.suggesterEmail ?? "", r]));
  const statesByEmail = new Map<string, Array<{ state: string; n: number }>>();
  for (const r of stateRows) {
    if (!r.suggesterEmail || !r.stateCode) continue;
    const list = statesByEmail.get(r.suggesterEmail) ?? [];
    list.push({ state: r.stateCode, n: r.n });
    statesByEmail.set(r.suggesterEmail, list);
  }
  const trustByEmail = new Map(trustRows.map((r) => [r.email, r]));

  const senders = inboundRows
    .map((i) => {
      const e = eventByEmail.get(i.fromAddress);
      const states = (statesByEmail.get(i.fromAddress) ?? []).sort((a, b) => b.n - a.n);
      const topState = states[0]?.state ?? null;
      const totalStateCounted = states.reduce((s, v) => s + v.n, 0);
      const neCount = states.filter((s) => NE_STATES.has(s.state)).reduce((s, v) => s + v.n, 0);
      const outOfArea = totalStateCounted > 0 && neCount / totalStateCounted < 0.5; // >50% non-NE = OOA
      const eventsCreated = e?.eventsCreated ?? 0;
      const approved = e?.approved ?? 0;
      const trust = trustByEmail.get(i.fromAddress);
      // Dedup-hit estimate: inbound submissions that didn't produce an
      // event AND weren't `failed` are likely dedup hits or no-URL replies.
      // Imperfect but useful as a first-order signal.
      const noEventOk = i.replied - eventsCreated;
      return {
        fromAddress: i.fromAddress,
        total: i.total,
        replied: i.replied,
        failed: i.failed,
        eventsCreated,
        approved,
        pending: e?.pending ?? 0,
        rejected: e?.rejected ?? 0,
        approvalRate: eventsCreated > 0 ? approved / eventsCreated : null,
        noEventOk,
        topState,
        outOfArea,
        stateBreakdown: states,
        firstSeen: new Date(i.firstSeen * 1000).toISOString(),
        lastSeen: new Date(i.lastSeen * 1000).toISOString(),
        trustStatus: trust?.trustStatus ?? "unknown",
        notes: trust?.notes ?? null,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  return NextResponse.json({ senders });
}
