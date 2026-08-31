export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, entityClaims, users, vendors } from "@/lib/db/schema";
import { buildSettledEntityClaim, shouldRecordEntityClaim } from "@takemetothefair/db-schema";
import { recomputeVendorCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
import { consumeClaimToken } from "@/lib/vendor-claim-token";
import { getSiteUrl } from "@/lib/email/send";
import { enqueueEmail } from "@/lib/queues/producers";
import { vendorClaimConfirmationTemplate } from "@/lib/email/templates";
import { logError } from "@/lib/logger";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

function redirectTo(path: string) {
  return NextResponse.redirect(`${getSiteUrl()}${path}`, { status: 303 });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  if (!token) {
    return redirectTo("/vendor/profile?claim_error=missing_token");
  }

  const db = getCloudflareDb();
  try {
    const result = await consumeClaimToken(db, token);
    if (!result.ok) {
      return redirectTo(`/vendor/profile?claim_error=${result.reason}`);
    }

    // Defence in depth: if the link is opened from a different account
    // than initiated, refuse. Without an active session, allow consumption
    // (vendor may not be logged in when clicking the email link in their
    // mail client; ownership was bound to userId at initiate time).
    if (session?.user?.id && session.user.id !== result.userId) {
      return redirectTo("/vendor/profile?claim_error=wrong_account");
    }

    const now = new Date();
    await db
      .update(vendors)
      .set({ claimed: true, claimedAt: now, claimedBy: result.userId })
      .where(eq(vendors.id, result.vendorId));

    // OPE-236 §4 — the canonical claim row. Same proof class as the email-match
    // route: the confirmation link was delivered to `vendor.contact_email`, so
    // clicking it demonstrates control of the listing's own mailbox. Recorded as
    // EMAIL_MATCH rather than INVITE_TOKEN — INVITE_TOKEN means an invite WE
    // minted for a cold contact (see redeemClaimToken); this one the claimant
    // initiated themselves, and what a reviewer needs from `method` is what was
    // proved, not who started it.
    //
    // The idempotency guard is load-bearing here specifically: a claim-
    // confirmation link is the kind of thing a mail client prefetches and a
    // person then clicks, and `consumeClaimToken` returning ok twice would
    // otherwise mint two APPROVED rows for one claim.
    const priorClaims = await db
      .select({ userId: entityClaims.userId, status: entityClaims.status })
      .from(entityClaims)
      .where(
        and(eq(entityClaims.entityType, "VENDOR"), eq(entityClaims.entityId, result.vendorId))
      );

    if (shouldRecordEntityClaim(priorClaims, result.userId)) {
      await db.insert(entityClaims).values(
        buildSettledEntityClaim({
          entityType: "VENDOR",
          entityId: result.vendorId,
          userId: result.userId,
          method: "EMAIL_MATCH",
          decidedBy: result.userId,
          at: now,
          evidence: "clicked the confirmation link delivered to vendor.contact_email",
        })
      );
    }

    await recomputeVendorCompleteness(db, result.vendorId);

    await logEnrichment(db, {
      targetType: "vendor",
      targetId: result.vendorId,
      source: "vendor_self",
      status: "success",
      actorUserId: result.userId,
      fieldsChanged: ["claimed", "claimedAt", "claimedBy"],
      notes: "claim confirmation via email link",
    });

    await db.insert(adminActions).values({
      action: "vendor.claim_self_serve",
      actorUserId: result.userId,
      targetType: "vendor",
      targetId: result.vendorId,
      payloadJson: JSON.stringify({ via: "email_verification" }),
      createdAt: now,
    });

    // Send confirmation email + IndexNow ping (fire-and-forget; failures
    // shouldn't block the redirect since the claim itself succeeded).
    try {
      const [vendor] = await db
        .select({ businessName: vendors.businessName, slug: vendors.slug })
        .from(vendors)
        .where(eq(vendors.id, result.vendorId))
        .limit(1);
      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, result.userId))
        .limit(1);
      if (vendor && user?.email) {
        const tpl = vendorClaimConfirmationTemplate({
          businessName: vendor.businessName,
          vendorSlug: vendor.slug,
          siteUrl: getSiteUrl(),
        });
        await enqueueEmail({ to: user.email, ...tpl, source: "vendor.claim-confirm" });
      }
      if (vendor) {
        const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
        await pingIndexNow(db, indexNowUrlFor("vendors", vendor.slug), env, "vendor-claim");
      }
    } catch (postErr) {
      await logError(db, {
        level: "warn",
        message: "Vendor claim post-confirm side effects failed",
        error: postErr,
        source: "api/vendor/claim/confirm:post",
        context: { vendorId: result.vendorId },
      });
    }

    return redirectTo("/vendor/profile?claimed=1");
  } catch (e) {
    await logError(db, {
      message: "Vendor claim confirm failed",
      error: e,
      source: "api/vendor/claim/confirm",
    });
    return redirectTo("/vendor/profile?claim_error=server");
  }
}
