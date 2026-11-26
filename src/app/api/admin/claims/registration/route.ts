export const dynamic = "force-dynamic";
/**
 * OPE-1599 — record an operator's decision on a self-registered vendor listing.
 *
 * Suspending a listing is the existing soft delete (DELETE /api/admin/vendors/[id],
 * with its guards and audit row), which the button calls first. This route records
 * the outcome, and refuses to record SUSPENDED or SPAM for a listing that is still
 * live, so a failed delete can never read as a completed suspension.
 *
 * Emails no one.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAuthorized } from "@/lib/api/with-auth";
import { adminActions, vendorClaimEvidence, vendors } from "@/lib/db/schema";

const bodySchema = z.object({
  vendorId: z.string().min(1),
  decision: z.enum(["LOOKS_REAL", "SUSPENDED", "SPAM"]),
});

export const POST = withAuthorized(
  { source: "api/admin/claims/registration", allowReadonlyBearer: false },
  async ({ request, db, userId }) => {
    let parsed: z.infer<typeof bodySchema>;
    try {
      parsed = bodySchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { vendorId, decision } = parsed;

    const [vendor] = await db
      .select({ id: vendors.id, deletedAt: vendors.deletedAt })
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);
    if (!vendor) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (decision !== "LOOKS_REAL" && !vendor.deletedAt) {
      return NextResponse.json({ error: "listing_still_live" }, { status: 409 });
    }

    const now = new Date();
    const updated = await db
      .update(vendorClaimEvidence)
      .set({ reviewDecision: decision, reviewedAt: now, reviewedBy: userId ?? "internal" })
      .where(eq(vendorClaimEvidence.vendorId, vendorId))
      .returning({ id: vendorClaimEvidence.id });
    if (updated.length === 0) {
      return NextResponse.json({ error: "no_screen_row" }, { status: 404 });
    }

    await db.insert(adminActions).values({
      id: crypto.randomUUID(),
      createdAt: now,
      action: "vendor.registration_review",
      actorUserId: userId ?? null,
      targetType: "vendor",
      targetId: vendorId,
      payloadJson: JSON.stringify({ decision }),
    });

    return NextResponse.json({ ok: true, decision });
  }
);
