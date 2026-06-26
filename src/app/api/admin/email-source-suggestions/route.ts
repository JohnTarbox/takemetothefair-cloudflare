export const dynamic = "force-dynamic";
/**
 * GET /api/admin/email-source-suggestions — list pending source-domain
 * suggestions received via inbound email, for admin review.
 *
 * Backs the source_suggestion Tier-3 path (drizzle/0084). When a sender
 * emails us suggesting a website as an events source AND we don't already
 * pull from it (Tier 1) AND it's not informally used (Tier 2), the
 * handler INSERTs a row here for admin to evaluate. POST → approve|reject
 * transitions status off pending_review and writes an admin_actions audit row.
 *
 * Renamed from /api/admin/discovery-candidates in PR-F after the original
 * `discovery_candidates` table name collided with a pre-existing prod
 * table owned by a separate harvest-rules feature.
 */

import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { adminActions, discoveryCandidates, emailSourceSuggestions } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { logError } from "@/lib/logger";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const statusFilter = request.nextUrl.searchParams.get("status") ?? "pending_review";

  const rows = await db
    .select()
    .from(emailSourceSuggestions)
    .where(eq(emailSourceSuggestions.status, statusFilter))
    .orderBy(desc(emailSourceSuggestions.createdAt))
    .limit(200);

  return NextResponse.json({
    rows: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      reviewedAt: r.reviewedAt instanceof Date ? r.reviewedAt.toISOString() : r.reviewedAt,
    })),
  });
});

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  const body = (await request.json().catch(() => null)) as {
    id?: string;
    action?: "approve" | "reject";
    notes?: string;
  } | null;

  if (!body?.id || (body.action !== "approve" && body.action !== "reject")) {
    return NextResponse.json(
      { error: "id and action ('approve'|'reject') required" },
      { status: 400 }
    );
  }

  const newStatus = body.action === "approve" ? "active" : "rejected";
  await db
    .update(emailSourceSuggestions)
    .set({
      status: newStatus,
      reviewedAt: new Date(),
      reviewedByUserId: session.user.id,
      adminNotes: body.notes ?? null,
    })
    .where(eq(emailSourceSuggestions.id, body.id));

  await db.insert(adminActions).values({
    action: `email_source_suggestion.${body.action}`,
    actorUserId: session.user.id,
    targetType: "email_source_suggestion",
    targetId: body.id,
    payloadJson: JSON.stringify({ notes: body.notes ?? null }),
    createdAt: new Date(),
  });

  // Promote-on-approve: hand the suggested URL off to the daily NE event
  // discovery harvest by writing a `discovery_candidates` row. The harvest
  // skill (owned outside this repo) reads from that table; this closes the
  // C.8 loop that PR-D's table-rename collision opened up. Idempotent: if
  // the URL is already in discovery_candidates we skip the insert so we
  // don't override an existing snoozed/skipped/resolved decision the
  // harvest side may have made independently. Non-fatal on failure — the
  // approve itself succeeded; surfacing a queue-write hiccup as a 500 to
  // the admin would be worse than logging and moving on.
  if (body.action === "approve") {
    try {
      const [row] = await db
        .select({
          url: emailSourceSuggestions.url,
          host: emailSourceSuggestions.host,
        })
        .from(emailSourceSuggestions)
        .where(eq(emailSourceSuggestions.id, body.id))
        .limit(1);

      if (row?.url) {
        const existing = await db
          .select({ id: discoveryCandidates.id })
          .from(discoveryCandidates)
          .where(eq(discoveryCandidates.sourceUrl, row.url))
          .limit(1);

        if (existing.length === 0) {
          const now = new Date();
          await db.insert(discoveryCandidates).values({
            id: crypto.randomUUID(),
            ruleSlug: "email_suggestion",
            sourceType: "aggregator",
            sourceLabel: row.host || row.url,
            sourceUrl: row.url,
            status: "pending",
            notes: `Promoted from email_source_suggestions ${body.id} on ${now.toISOString()}`,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    } catch (err) {
      // Don't fail the approval over a queue-write hiccup; the admin
      // can re-trigger via /admin/email-source-suggestions if needed.
      await logError(db, {
        source: "api/admin/email-source-suggestions:promote",
        message: "Failed to promote approved suggestion to discovery_candidates",
        error: err,
        context: { suggestionId: body.id },
      });
    }
  }

  return NextResponse.json({ success: true, status: newStatus });
});
