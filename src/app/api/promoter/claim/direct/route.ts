/**
 * Self-service one-click promoter claim, gated on email-match.
 *
 * Parallels src/app/api/vendor/claim/direct/route.ts. Differences from
 * the vendor variant:
 *   - promoters has NO `claimed` column today (most promoter rows
 *     are created at signup with role=PROMOTER, so the "is this
 *     claimed?" notion is implicit in user_id being non-null).
 *   - promoters.user_id is UNIQUE — only one user can own a given
 *     promoter row. So the contention case ("already claimed by
 *     another live user") is enforced by the FK constraint itself.
 *   - 2 of 422 promoter rows in prod have user_id IS NULL (low
 *     volume, but the path is supported).
 *
 * Preconditions enforced server-side:
 *   - Session exists
 *   - users.email_verified IS NOT NULL
 *   - promoters.slug matches
 *   - promoters.contact_email matches users.email (case-insensitive trim)
 *   - promoters.user_id is NULL  OR  === session.user.id (idempotent)
 *
 * Side effects on success:
 *   - promoters.user_id transferred to current user (if was NULL)
 *   - user_roles += {PROMOTER} (idempotent via onConflictDoNothing)
 *   - admin_actions row
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, promoters, userRoles, users } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { unsafeSlug } from "@/lib/utils";

export const runtime = "edge";

const schema = z.object({
  slug: z.string().min(1).max(200),
});

function emailEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { slug?: unknown };
  try {
    body = (await request.json()) as { slug?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", detail: parsed.error.issues[0]?.message ?? "validation failed" },
      { status: 400 }
    );
  }

  const db = getCloudflareDb();

  try {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!user.emailVerified) {
      return NextResponse.json(
        {
          error: "email_unverified",
          message:
            "Please verify your email before claiming a listing. Check your inbox or use the resend link in the banner at the top of the page.",
        },
        { status: 403 }
      );
    }

    const [promoter] = await db
      .select({
        id: promoters.id,
        slug: promoters.slug,
        userId: promoters.userId,
        companyName: promoters.companyName,
        contactEmail: promoters.contactEmail,
      })
      .from(promoters)
      .where(eq(promoters.slug, unsafeSlug(parsed.data.slug)))
      .limit(1);

    if (!promoter) {
      return NextResponse.json({ error: "promoter_not_found" }, { status: 404 });
    }

    if (!emailEq(promoter.contactEmail, user.email)) {
      return NextResponse.json(
        {
          error: "not_eligible_for_email_match",
          message:
            "This promoter's contact email doesn't match your account email. Contact support if you need to claim it via a different verification.",
        },
        { status: 403 }
      );
    }

    if (promoter.userId && promoter.userId !== user.id) {
      return NextResponse.json(
        {
          error: "already_claimed",
          message:
            "This promoter has been claimed by another account. If that's an error, please contact support.",
        },
        { status: 409 }
      );
    }

    const now = new Date();

    // promoters.user_id is UNIQUE — the FK enforces that no two users
    // own the same promoter row. If userId was already === user.id
    // (the idempotent re-claim case), this is a no-op set.
    if (promoter.userId !== user.id) {
      await db.update(promoters).set({ userId: user.id }).where(eq(promoters.id, promoter.id));
    }

    await db
      .insert(userRoles)
      .values({ userId: user.id, role: "PROMOTER", grantedAt: now, grantedBy: user.id })
      .onConflictDoNothing();

    await db.insert(adminActions).values({
      action: "promoter.claim_self_serve_email_match",
      actorUserId: user.id,
      targetType: "promoter",
      targetId: promoter.id,
      payloadJson: JSON.stringify({
        via: "email_match",
        userEmail: user.email,
        promoterContactEmail: promoter.contactEmail,
      }),
      createdAt: now,
    });

    try {
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("promoters", promoter.slug), env, "promoter-claim");
    } catch (pingErr) {
      await logError(db, {
        level: "warn",
        message: "Promoter claim IndexNow ping failed",
        error: pingErr,
        source: "api/promoter/claim/direct:indexnow",
        context: { promoterId: promoter.id, slug: promoter.slug },
      });
    }

    return NextResponse.json({
      ok: true,
      promoter: { id: promoter.id, slug: promoter.slug, companyName: promoter.companyName },
      grantedRole: "PROMOTER",
    });
  } catch (e) {
    await logError(db, {
      message: "Promoter self-service claim threw",
      error: e,
      source: "api/promoter/claim/direct",
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
