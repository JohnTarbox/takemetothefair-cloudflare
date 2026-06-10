export const dynamic = "force-dynamic";
/**
 * POST /api/admin/inbound-emails/[id]/salvage — admin manually associates
 * an inbound_email with one or more events created from its content, and
 * fires a notification to the submitter.
 *
 * Analyst Item 19 (2026-05-25). The K1LX case: a forwarded hamfest list-
 * page submission that became 4 hand-created events with no follow-up
 * email. After this endpoint runs the submitter gets one summary email
 * with links to every salvaged event.
 *
 * Auth: admin session OR X-Internal-Key.
 * Body: `{ event_ids: string[] }` — 1-20 event UUIDs in display order.
 *
 * Side effects:
 *   - inbound_emails.resulting_event_id ← event_ids[0] (display "primary")
 *   - inbound_emails.status ← 'salvaged' (if not already terminal)
 *   - One EMAIL_JOBS message via notifySalvageIfNeeded (idempotent;
 *     gated on salvage_notified_at)
 *   - admin_actions audit row
 *
 * Returns the notify outcome so the admin UI can show "sent" or
 * "already-notified" without re-querying D1.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { timingSafeEqualString } from "@takemetothefair/utils";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, inboundEmails } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { notifySalvageIfNeeded } from "@/lib/salvage-notification";

const MAX_EVENTS_PER_SALVAGE = 20;

interface SalvageBody {
  event_ids?: unknown;
}

interface AuthResult {
  ok: boolean;
  actorUserId: string | null;
}

async function authorize(
  request: NextRequest,
  env: { INTERNAL_API_KEY?: string }
): Promise<AuthResult> {
  const internalKey = request.headers.get("X-Internal-Key");
  if (await timingSafeEqualString(internalKey, env.INTERNAL_API_KEY)) {
    return { ok: true, actorUserId: null };
  }
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { ok: true, actorUserId: session.user.id };
  }
  return { ok: false, actorUserId: null };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getCloudflareEnv() as unknown as {
    INTERNAL_API_KEY?: string;
    EMAIL_JOBS?: Queue<unknown>;
  };
  const authResult = await authorize(request, env);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "inbound email id required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as SalvageBody;
  if (!Array.isArray(body.event_ids) || body.event_ids.length === 0) {
    return NextResponse.json({ error: "event_ids must be a non-empty array" }, { status: 400 });
  }
  const eventIds = body.event_ids.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (eventIds.length === 0) {
    return NextResponse.json({ error: "no valid event_ids supplied" }, { status: 400 });
  }
  if (eventIds.length > MAX_EVENTS_PER_SALVAGE) {
    return NextResponse.json(
      { error: `at most ${MAX_EVENTS_PER_SALVAGE} events per salvage call` },
      { status: 400 }
    );
  }
  // Deduplicate while preserving the admin's intended order.
  const seen = new Set<string>();
  const dedupedIds = eventIds.filter((v) => (seen.has(v) ? false : (seen.add(v), true)));

  const db = getCloudflareDb();
  try {
    // Confirm the inbound row exists before touching anything — gives a
    // clean 404 instead of a partial linkage write.
    const [row] = await db
      .select({
        id: inboundEmails.id,
        status: inboundEmails.status,
        fromAddress: inboundEmails.fromAddress,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, id))
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "inbound email not found" }, { status: 404 });
    }

    // Write the linkage. Setting status='salvaged' covers the common case
    // (admin reviewed a failed/received row and finished it manually).
    // We don't overwrite already-terminal statuses (replied/forwarded) —
    // an admin might be salvaging in addition to a prior auto-reply.
    const newStatus =
      row.status === "replied" || row.status === "forwarded" ? row.status : "salvaged";
    await db
      .update(inboundEmails)
      .set({ status: newStatus, resultingEventId: dedupedIds[0] })
      .where(eq(inboundEmails.id, id));

    // Send the notification. Helper handles the idempotency check
    // against salvage_notified_at.
    const notify = await notifySalvageIfNeeded(db, env, id, dedupedIds);

    // Audit log — record who, when, and what was linked. Salvage history
    // is useful for retroactive trust-tier adjustments on the sender.
    await db.insert(adminActions).values({
      action: "inbound_email.salvaged",
      actorUserId: authResult.actorUserId,
      targetType: "inbound_email",
      targetId: id,
      payloadJson: JSON.stringify({
        eventIds: dedupedIds,
        notifyOutcome: notify.outcome,
        eventsListed: notify.eventsListed,
        previousStatus: row.status,
        newStatus,
      }),
      createdAt: new Date(),
    });

    return NextResponse.json({
      success: true,
      inbound_email_id: id,
      previous_status: row.status,
      new_status: newStatus,
      events_linked: dedupedIds,
      notify_outcome: notify.outcome,
      events_in_email: notify.eventsListed,
    });
  } catch (e) {
    await logError(db, {
      source: "admin:inbound-emails:salvage",
      level: "error",
      message: "Salvage failed",
      error: e,
    });
    return NextResponse.json({ error: "Salvage failed" }, { status: 500 });
  }
}
