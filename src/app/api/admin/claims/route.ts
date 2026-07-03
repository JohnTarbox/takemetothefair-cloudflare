export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { approveClaim, rejectClaim } from "@/lib/claims/admin-review";

const bodySchema = z.object({
  claimId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  reason: z.string().max(1000).optional(),
});

/**
 * OPE-65 — admin approve/reject a vendor|promoter claim from the /admin/claims
 * queue. `{ ok:false, reason }` from the core maps to 409 (conflict — the claim
 * isn't in a reviewable state, or the entity is disputed); `{ ok:true }` → 200.
 */
export const POST = withAuth(
  { role: "ADMIN", source: "api/admin/claims" },
  async ({ request, db, session }) => {
    let parsed: z.infer<typeof bodySchema>;
    try {
      parsed = bodySchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { claimId, action, reason } = parsed;

    if (action === "reject" && (!reason || reason.trim().length === 0)) {
      return NextResponse.json(
        { error: "A reason is required to reject a claim" },
        { status: 400 }
      );
    }

    try {
      const result =
        action === "approve"
          ? await approveClaim(db, { claimId, actorUserId: session.user.id })
          : await rejectClaim(db, {
              claimId,
              actorUserId: session.user.id,
              reason: reason!.trim(),
            });

      if (!result.ok) {
        return NextResponse.json({ error: result.reason, ...result }, { status: 409 });
      }
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      await logError(db, {
        message: "Failed to decide claim",
        error,
        source: "api/admin/claims",
        request,
      });
      return NextResponse.json({ error: "Failed to decide claim" }, { status: 500 });
    }
  }
);
