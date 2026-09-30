export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, promoters, performers, entityClaims } from "@/lib/db/schema";
import { unsafeSlug } from "@/lib/utils";
import { parseGaClientId } from "@/lib/ga4-measurement-protocol";
import { trackClaimVerificationAttemptedServer } from "@/lib/analytics/claim-funnel";
import { logError } from "@/lib/logger";

/**
 * "Verify another way" evidence intake — OPE-59.
 *
 * Auth-gated to the logged-in user. Records free-text evidence for a PENDING
 * claim the user is making on a vendor/promoter listing (the rung-4 EVIDENCE
 * path), and surfaces it to operators by writing a `problem_reports` row (the
 * existing admin problem-report surface). Idempotent-ish: reuses the user's
 * existing PENDING entity_claims row for the entity if one exists (e.g. the one
 * written at signup), otherwise creates one.
 *
 * This NEVER grants the claim — it only attaches evidence and flags it for
 * review. Approval happens later via the admin claim queue (OPE-65).
 */
const bodySchema = z.object({
  // OPE-318 — PERFORMER joins the claimable set.
  entityType: z.enum(["VENDOR", "PROMOTER", "PERFORMER"]),
  slug: z.string().min(1),
  evidence: z.string().min(1, "Please describe how you're connected.").max(4000),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const db = getCloudflareDb();
  try {
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid request" },
        { status: 400 }
      );
    }
    const { entityType, slug, evidence } = parsed.data;

    // Resolve the entity id from the slug (polymorphic entity_claims has no FK).
    let entityId: string | undefined;
    if (entityType === "VENDOR") {
      const [row] = await db
        .select({ id: vendors.id, businessName: vendors.businessName })
        .from(vendors)
        .where(eq(vendors.slug, unsafeSlug(slug)))
        .limit(1);
      entityId = row?.id;
    } else if (entityType === "PERFORMER") {
      const [row] = await db
        .select({ id: performers.id, name: performers.name })
        .from(performers)
        .where(eq(performers.slug, unsafeSlug(slug)))
        .limit(1);
      entityId = row?.id;
    } else {
      const [row] = await db
        .select({ id: promoters.id, companyName: promoters.companyName })
        .from(promoters)
        .where(eq(promoters.slug, unsafeSlug(slug)))
        .limit(1);
      entityId = row?.id;
    }
    if (!entityId) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    const now = new Date();

    // Find this user's existing PENDING claim for the entity, else create one.
    const [existing] = await db
      .select({ id: entityClaims.id })
      .from(entityClaims)
      .where(
        and(
          eq(entityClaims.entityType, entityType),
          eq(entityClaims.entityId, entityId),
          eq(entityClaims.userId, userId),
          eq(entityClaims.status, "PENDING")
        )
      )
      .limit(1);

    if (existing) {
      await db
        .update(entityClaims)
        .set({ evidence, method: "EVIDENCE" })
        .where(eq(entityClaims.id, existing.id));
    } else {
      await db.insert(entityClaims).values({
        id: crypto.randomUUID(),
        entityType,
        entityId,
        userId,
        method: "EVIDENCE",
        status: "PENDING",
        evidence,
        createdAt: now,
      });
    }

    // OPE-769 — the problem_reports row that used to be written here is gone.
    //
    // It was a notification hack, and the evidence is ALREADY persisted: the
    // `entity_claims` write above is the same request, so the row was
    // double-filed. The copy in `problem_reports` then polluted the defect
    // queue — four of its five open `web` rows were claim evidence, so
    // "5 unresolved problem reports" read as five open bugs when it was one.
    //
    // A claim reviewer's surface is `list_claims` / `/admin/claims`, reading
    // `entity_claims`, which is where this evidence now lives and only lives.
    //
    // ⚠️ This DOES remove a (weak) operator signal, and nothing here replaces
    // it — notifying on a pending claim is OPE-599, which is open and is the
    // right place for it. The signal was reaching the wrong queue anyway:
    // Emma Welford's promoter evidence sat in `problem_reports` from 08-17 and
    // no claim reviewer would ever have looked there.

    // OPE-66 — filing evidence IS the rung-4 (EVIDENCE) verification attempt.
    // Server-side, ad-block-proof; `slug` is the public `entity_id` custom dim.
    const clientId = parseGaClientId(request.headers.get("cookie")) ?? crypto.randomUUID();
    await trackClaimVerificationAttemptedServer({
      clientId,
      entityType,
      entitySlug: slug,
      method: "EVIDENCE",
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    await logError(db, {
      message: "Claim evidence submission failed",
      error: e,
      source: "api/claim/evidence",
      request,
    });
    return NextResponse.json({ error: "Failed to submit evidence" }, { status: 500 });
  }
}
