export const dynamic = "force-dynamic";
/**
 * OPE-177 (scope #4) — admin support affordance: manually mark a user's email
 * verified. Unblocks accounts stuck with email_verified=NULL because the
 * verification email never reached them (cf-email has no delivery feedback; a
 * resend via the same path would fail the same way, so mark-verified is the
 * useful escape hatch). Admin-gated; idempotent (no-op if already verified).
 * Sets only email_verified — does NOT run the token flow's claim auto-approval.
 */
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { users, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const POST = withAuth<{ id: string }>(
  { role: "ADMIN", source: "api/admin/users/[id]/mark-verified" },
  async ({ db, session, params }) => {
    const { id } = params;

    const [user] = await db
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const now = new Date();
    if (!user.emailVerified) {
      await db.update(users).set({ emailVerified: now, updatedAt: now }).where(eq(users.id, id));
      await db.insert(adminActions).values({
        action: "user.email_verified_manual",
        actorUserId: session.user.id,
        targetType: "user",
        targetId: id,
        payloadJson: JSON.stringify({ email: user.email }),
        createdAt: now,
      });
    }

    return NextResponse.json({
      success: true,
      id,
      email: user.email,
      emailVerified: (user.emailVerified ?? now).toISOString(),
    });
  }
);
