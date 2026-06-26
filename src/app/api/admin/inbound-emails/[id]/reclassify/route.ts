export const dynamic = "force-dynamic";
/**
 * POST /api/admin/inbound-emails/[id]/reclassify — admin reclassifies
 * an inbound email's intent. Writes a row to
 * inbound_email_intent_feedback (feedback_source='admin_reroute'),
 * updates inbound_emails.intent to the corrected value, and inserts
 * an admin_actions audit row. Spec §D.1.
 *
 * Body: `{ correctedIntent: string, adminNote?: string,
 *          alsoRerunWorkflow?: boolean }`
 *
 * If alsoRerunWorkflow=true, the request proxies to the MCP worker to
 * create a fresh InboundEmailWorkflow instance for the updated intent.
 */

import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, inboundEmails, inboundEmailIntentFeedback } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const MCP_URL = "https://mcp.meetmeatthefair.com";

// Same 13-value union as mcp-server/src/email-intents.ts EmailIntent.
// Replicated here as a Set so the API route can validate without
// importing across the worker boundary.
const VALID_INTENTS = new Set([
  "submit",
  "new_event",
  "correction",
  "source_suggestion",
  "claim_request",
  "vendor_inquiry",
  "support",
  "press",
  "unsubscribe",
  "spam",
  "unclear",
  "multi",
  "unknown",
]);

interface Body {
  correctedIntent?: unknown;
  adminNote?: unknown;
  alsoRerunWorkflow?: unknown;
}

export const POST = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, session, params }) => {
    const { id } = params;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    if (typeof body.correctedIntent !== "string" || !VALID_INTENTS.has(body.correctedIntent)) {
      return NextResponse.json(
        {
          error: "correctedIntent must be one of the valid intent values",
          valid: [...VALID_INTENTS],
        },
        { status: 400 }
      );
    }
    const correctedIntent = body.correctedIntent;
    const adminNote =
      typeof body.adminNote === "string" && body.adminNote.length > 0
        ? body.adminNote.slice(0, 1000)
        : null;
    const alsoRerunWorkflow = body.alsoRerunWorkflow === true;

    // Fetch current row state — we need original_intent + classifier_version
    // for the audit trail, and to detect no-op reclassifications.
    const rows = await db
      .select({
        intent: inboundEmails.intent,
        classifiedIntent: inboundEmails.classifiedIntent,
        classifierVersion: inboundEmails.classifierVersion,
      })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, id))
      .limit(1);
    if (rows.length === 0) {
      return NextResponse.json({ error: "inbound_email not found" }, { status: 404 });
    }
    const before = rows[0];
    const originalIntent = before.classifiedIntent ?? before.intent;

    // Skip the feedback write on a no-op reclassification — leaves the
    // dashboard accuracy metric clean.
    if (before.intent === correctedIntent && before.classifiedIntent === correctedIntent) {
      return NextResponse.json({ ok: true, noop: true });
    }

    const now = new Date();
    await db.insert(inboundEmailIntentFeedback).values({
      id: crypto.randomUUID(),
      inboundEmailId: id,
      feedbackSource: "admin_reroute",
      originalIntent,
      correctedIntent,
      classifierVersion: before.classifierVersion,
      adminNote,
      createdBy: session.user.id,
      createdAt: now,
    });

    await db.update(inboundEmails).set({ intent: correctedIntent }).where(eq(inboundEmails.id, id));

    await db.insert(adminActions).values({
      action: "inbound_email.reclassify",
      actorUserId: session.user.id,
      targetType: "inbound_email",
      targetId: id,
      payloadJson: JSON.stringify({
        from: originalIntent,
        to: correctedIntent,
        note: adminNote,
        alsoRerunWorkflow,
      }),
      createdAt: now,
    });

    // Optional: re-run the workflow with the corrected intent. Proxies
    // to MCP because the workflow binding lives there.
    let rerunStatus: number | null = null;
    if (alsoRerunWorkflow) {
      const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
      if (!cfEnv.INTERNAL_API_KEY) {
        return NextResponse.json(
          { ok: true, rerunSkipped: "INTERNAL_API_KEY missing" },
          { status: 200 }
        );
      }
      const upstream = await fetch(
        `${MCP_URL}/api/admin/inbound-emails/${encodeURIComponent(id)}/rerun`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-key": cfEnv.INTERNAL_API_KEY,
          },
          body: JSON.stringify({ intent: correctedIntent }),
        }
      );
      rerunStatus = upstream.status;
    }

    return NextResponse.json({ ok: true, rerunStatus });
  }
);
