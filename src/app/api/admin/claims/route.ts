export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuthorized } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { approveClaim, rejectClaim } from "@/lib/claims/admin-review";

const bodySchema = z.object({
  claimId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  reason: z.string().max(1000).optional(),
  /**
   * OPE-792 — who decided, for the audit row, when the caller is the MCP server
   * over X-Internal-Key and therefore has no session. IGNORED when an admin
   * session is present: a session's own id always wins, so this can never be
   * used to attribute a decision to somebody else.
   */
  actorUserId: z.string().min(1).max(128).optional(),
});

/**
 * OPE-65 — admin approve/reject a vendor|promoter claim from the /admin/claims
 * queue. `{ ok:false, reason }` from the core maps to 409 (conflict — the claim
 * isn't in a reviewable state, or the entity is disputed); `{ ok:true }` → 200.
 */
/**
 * OPE-792 — accepts an ADMIN session OR `X-Internal-Key`.
 *
 * Widened so the MCP `approve_claim` / `reject_claim` tools can DELEGATE here
 * instead of re-implementing the transition. They had re-implemented it — the
 * MCP copy performed the ownership transfer, the role grant, the status flip
 * and the audit row, and skipped the two things only the core does: the
 * claimant notification row and the decision email. Result: three claims
 * approved, `claims.decision` never once written to `email_send_ledger`, and
 * one claimant told by hand.
 *
 * Mirrors the OPE-190 widening of /api/admin/newsletter/send for the same
 * reason and via the same wrapper.
 */
export const POST = withAuthorized(
  { source: "api/admin/claims", allowReadonlyBearer: false },
  async ({ request, db, userId }) => {
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
      // Session id wins; the body's actorUserId only fills in for the
      // internal-key path, which has no session. "internal" is the last resort
      // so an audit row is never written with an empty actor.
      const actorUserId = userId ?? parsed.actorUserId ?? "internal";
      const result =
        action === "approve"
          ? await approveClaim(db, { claimId, actorUserId })
          : await rejectClaim(db, {
              claimId,
              actorUserId,
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
