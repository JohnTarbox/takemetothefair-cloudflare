/**
 * Self-service one-click vendor claim, gated on email-match.
 *
 * The "claim a vendor" flow has two paths:
 *
 *   1. **Existing two-step flow** (POST /api/vendor/claim/initiate
 *      + GET /api/vendor/claim/confirm) — for users whose signup
 *      email is different from the vendor's listed contact_email.
 *      Sends a separate email to prove control of that mailbox.
 *
 *   2. **Email-match short-circuit** (THIS endpoint) — for users
 *      whose verified signup email is the SAME as the vendor's
 *      contact_email. The verification step already proved control
 *      of that mailbox; adding a second email round-trip is
 *      redundant. So claim completes in one click here.
 *
 * Preconditions enforced server-side (defense-in-depth — the UI
 * shouldn't expose the button when these aren't met, but the API
 * must validate independently):
 *   - Session exists (logged in)
 *   - users.email_verified IS NOT NULL
 *   - vendors.slug matches
 *   - vendors.contact_email matches users.email (case-insensitive trim)
 *   - vendors.claimed = false  OR  vendors.user_id already === session.user.id
 *     (idempotent re-claim by the rightful owner is OK)
 *
 * Side effects on success:
 *   - vendors.claimed = true, claimed_at, claimed_by stamped
 *   - vendors.user_id transferred to current user (if not already)
 *   - user_roles += {VENDOR} (idempotent via onConflictDoNothing)
 *   - admin_actions row (action: 'vendor.claim_self_serve_email_match')
 *   - enrichment log
 *   - IndexNow ping for vendor URL
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, userRoles, users, vendors } from "@/lib/db/schema";
import { recomputeVendorCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
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
    // Load the user row and confirm verification. The session carries
    // email but not email_verified, so we re-read from D1.
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

    // Load the target vendor row.
    const [vendor] = await db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        userId: vendors.userId,
        businessName: vendors.businessName,
        contactEmail: vendors.contactEmail,
        claimed: vendors.claimed,
      })
      .from(vendors)
      .where(eq(vendors.slug, unsafeSlug(parsed.data.slug)))
      .limit(1);

    if (!vendor) {
      return NextResponse.json({ error: "vendor_not_found" }, { status: 404 });
    }

    // Email-match precondition. We don't 403 with a leaky message — just
    // say it's not eligible. The UI shouldn't have offered the button if
    // emails didn't match, so a request reaching here without a match is
    // either a stale tab, a manual curl, or a recent profile edit that
    // changed contact_email.
    if (!emailEq(vendor.contactEmail, user.email)) {
      return NextResponse.json(
        {
          error: "not_eligible_for_email_match",
          message:
            "This listing's contact email doesn't match your account email. Use the standard claim flow (the system will send a separate confirmation email).",
        },
        { status: 403 }
      );
    }

    // Conflict check: claimed by a different live user already?
    if (vendor.claimed && vendor.userId && vendor.userId !== user.id) {
      return NextResponse.json(
        {
          error: "already_claimed",
          message:
            "This listing has been claimed by another account. If that's an error, please contact support.",
        },
        { status: 409 }
      );
    }

    const now = new Date();

    // Single-statement updates (no db.batch since we need the result of
    // the prior step to fire side effects; sequential is fine for a
    // sub-200ms flow). We update the vendor row, mirror to user_roles,
    // and write the audit + enrichment rows. The vendor.userId
    // transfer is idempotent — assigning the same id is a no-op.
    await db
      .update(vendors)
      .set({
        userId: user.id,
        claimed: true,
        claimedAt: now,
        claimedBy: user.id,
      })
      .where(eq(vendors.id, vendor.id));

    await db
      .insert(userRoles)
      .values({ userId: user.id, role: "VENDOR", grantedAt: now, grantedBy: user.id })
      .onConflictDoNothing();

    await recomputeVendorCompleteness(db, vendor.id);

    await logEnrichment(db, {
      targetType: "vendor",
      targetId: vendor.id,
      source: "vendor_self",
      status: "success",
      actorUserId: user.id,
      fieldsChanged: ["claimed", "claimedAt", "claimedBy"],
      notes: "self-service claim via email-match (PR 1)",
    });

    await db.insert(adminActions).values({
      action: "vendor.claim_self_serve_email_match",
      actorUserId: user.id,
      targetType: "vendor",
      targetId: vendor.id,
      payloadJson: JSON.stringify({
        via: "email_match",
        userEmail: user.email,
        vendorContactEmail: vendor.contactEmail,
      }),
      createdAt: now,
    });

    // Fire-and-forget IndexNow ping so search engines pick up the
    // refreshed (now-claimed) vendor page sooner. Failures are
    // logged but don't fail the claim.
    try {
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("vendors", vendor.slug), env, "vendor-claim");
    } catch (pingErr) {
      await logError(db, {
        level: "warn",
        message: "Vendor claim IndexNow ping failed",
        error: pingErr,
        source: "api/vendor/claim/direct:indexnow",
        context: { vendorId: vendor.id, slug: vendor.slug },
      });
    }

    return NextResponse.json({
      ok: true,
      vendor: { id: vendor.id, slug: vendor.slug, businessName: vendor.businessName },
      grantedRole: "VENDOR",
    });
  } catch (e) {
    await logError(db, {
      message: "Vendor self-service claim threw",
      error: e,
      source: "api/vendor/claim/direct",
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
