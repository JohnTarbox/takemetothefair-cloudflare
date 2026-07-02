export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, promoters, entityClaims, problemReports } from "@/lib/db/schema";
import { unsafeSlug } from "@/lib/utils";
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
  entityType: z.enum(["VENDOR", "PROMOTER"]),
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
    let entityName = slug;
    if (entityType === "VENDOR") {
      const [row] = await db
        .select({ id: vendors.id, businessName: vendors.businessName })
        .from(vendors)
        .where(eq(vendors.slug, unsafeSlug(slug)))
        .limit(1);
      entityId = row?.id;
      if (row) entityName = row.businessName;
    } else {
      const [row] = await db
        .select({ id: promoters.id, companyName: promoters.companyName })
        .from(promoters)
        .where(eq(promoters.slug, unsafeSlug(slug)))
        .limit(1);
      entityId = row?.id;
      if (row) entityName = row.companyName;
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

    // Surface to operators via the existing problem-report queue.
    const who = session.user.email || userId;
    await db.insert(problemReports).values({
      id: crypto.randomUUID(),
      reporterEmail: session.user.email ?? null,
      body: `Claim evidence: ${who} for ${entityType.toLowerCase()} ${slug} (${entityName})\n\n${evidence}`,
      source: "web",
      path: `/claim/verify/${entityType.toLowerCase()}/${slug}`,
      userAgent: request.headers.get("user-agent"),
      inboundEmailId: null,
      severity: "LOW",
      correlatedErrorCount: 0,
      createdAt: now,
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
