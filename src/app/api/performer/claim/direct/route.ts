export const dynamic = "force-dynamic";
/**
 * OPE-116 (3/3) — self-service one-click performer claim, gated on email-match.
 *
 * Mirrors src/app/api/promoter/claim/direct/route.ts. A performer (act) is
 * claimed when the signed-in, email-verified user's account email matches the
 * `contact_email` on the performer row. Success marks the row claimed and
 * transfers ownership (performers.user_id is UNIQUE, so one user owns one act).
 *
 * NO role grant: there is no /performer/* portal yet, and userRoles.role has no
 * PERFORMER value — ownership is tracked on performers.user_id + claimed. When a
 * performer portal ships, a follow-up can add the role + grant here.
 *
 * Non-email-match ownership (most harvested acts have a null contact_email) is
 * handled operator-side by the admin_approve_performer_claim MCP tool.
 *
 * Preconditions enforced server-side:
 *   - Session exists
 *   - users.email_verified IS NOT NULL
 *   - performers.slug matches, not soft-deleted
 *   - performers.contact_email matches users.email (case-insensitive trim)
 *   - performers.claimed = false  OR  already owned by this user (idempotent)
 */
import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, performers, users } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { unsafeSlug } from "@/lib/utils";

const schema = z.object({ slug: z.string().min(1).max(200) });

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
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
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
            "Please verify your email before claiming a profile. Check your inbox or use the resend link in the banner at the top of the page.",
        },
        { status: 403 }
      );
    }

    const [performer] = await db
      .select({
        id: performers.id,
        slug: performers.slug,
        userId: performers.userId,
        claimed: performers.claimed,
        name: performers.name,
        contactEmail: performers.contactEmail,
        deletedAt: performers.deletedAt,
      })
      .from(performers)
      .where(eq(performers.slug, unsafeSlug(parsed.data.slug)))
      .limit(1);

    if (!performer || performer.deletedAt) {
      return NextResponse.json({ error: "performer_not_found" }, { status: 404 });
    }

    if (!emailEq(performer.contactEmail, user.email)) {
      return NextResponse.json(
        {
          error: "not_eligible_for_email_match",
          message:
            "This act's contact email doesn't match your account email. Contact support if you need to verify ownership another way.",
        },
        { status: 403 }
      );
    }

    if (performer.claimed && performer.userId && performer.userId !== user.id) {
      return NextResponse.json(
        {
          error: "already_claimed",
          message:
            "This profile has been claimed by another account. If that's an error, please contact support.",
        },
        { status: 409 }
      );
    }

    const now = new Date();
    // Guarded by claimed=false so a concurrent claim can't be clobbered
    // (idempotent no-op when this user already owns it).
    if (!(performer.claimed && performer.userId === user.id)) {
      await db
        .update(performers)
        .set({ userId: user.id, claimed: true, claimedAt: now, claimedBy: user.id, updatedAt: now })
        .where(and(eq(performers.id, performer.id), isNull(performers.userId)));
    }

    await db.insert(adminActions).values({
      action: "performer.claim_self_serve_email_match",
      actorUserId: user.id,
      targetType: "performer",
      targetId: performer.id,
      payloadJson: JSON.stringify({
        via: "email_match",
        userEmail: user.email,
        performerContactEmail: performer.contactEmail,
      }),
      createdAt: now,
    });

    try {
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("performers", performer.slug), env, "performer-claim");
    } catch (pingErr) {
      await logError(db, {
        level: "warn",
        message: "Performer claim IndexNow ping failed",
        error: pingErr,
        source: "api/performer/claim/direct:indexnow",
        context: { performerId: performer.id, slug: performer.slug },
      });
    }

    return NextResponse.json({
      ok: true,
      performer: { id: performer.id, slug: performer.slug, name: performer.name },
    });
  } catch (e) {
    await logError(db, {
      message: "Performer self-service claim threw",
      error: e,
      source: "api/performer/claim/direct",
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
