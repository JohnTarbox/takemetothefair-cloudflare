import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users } from "@/lib/db/schema";
import { createClaimToken } from "@/lib/vendor-claim-token";
import { getSiteUrl } from "@/lib/email/send";
import { enqueueEmail } from "@/lib/queues/producers";
import { vendorClaimVerificationTemplate } from "@/lib/email/templates";
import { logError } from "@/lib/logger";

export const runtime = "edge";

/**
 * Mask the local-part of an email for surfacing in API responses.
 * "info@business.com" → "in***@business.com". Leaves the first 2
 * characters of the local-part visible plus the full domain. Local
 * parts shorter than 2 chars get a single character + asterisks.
 */
function maskEmail(addr: string): string {
  const at = addr.indexOf("@");
  if (at < 0) return "***";
  const local = addr.slice(0, at);
  const domain = addr.slice(at);
  const visible = local.length >= 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}${domain}`;
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  try {
    const [vendor] = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        userId: vendors.userId,
        claimed: vendors.claimed,
        contactEmail: vendors.contactEmail,
      })
      .from(vendors)
      .where(eq(vendors.userId, session.user.id))
      .limit(1);

    if (!vendor) {
      return NextResponse.json({ error: "No vendor record for this account" }, { status: 404 });
    }
    if (vendor.claimed) {
      return NextResponse.json({ error: "Already claimed" }, { status: 409 });
    }

    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    if (!user?.email) {
      return NextResponse.json(
        { error: "Account has no email on file; contact support" },
        { status: 422 }
      );
    }

    // Option C destination policy. Three branches:
    //
    //  1. vendor.contact_email is set AND differs from user.email
    //     (case-insensitive): send to vendor.contact_email. The
    //     verification step at signup already proved user.email; this
    //     additional step proves the claimer has access to the
    //     business's listed mailbox — the actual business-ownership
    //     check.
    //
    //  2. vendor.contact_email matches user.email (email-match case):
    //     the user SHOULD have gone through /api/vendor/claim/direct
    //     (one-click, no email round-trip). Reaching this endpoint
    //     means the UI dispatch missed somehow — fall back to sending
    //     to user.email, which is what the original flow did. The
    //     mail still delivers; the user clicks the link; same outcome.
    //
    //  3. vendor.contact_email is null/empty: the business has no
    //     listed contact mailbox we can verify. We REFUSE the claim
    //     here — return a structured error so the UI can guide the
    //     user to contact support. Admin can then approve manually
    //     via the MCP `admin_approve_vendor_claim` tool.
    const vendorEmail = vendor.contactEmail?.trim() ?? "";
    const userEmail = user.email.trim();
    const emailsMatch =
      vendorEmail.length > 0 && vendorEmail.toLowerCase() === userEmail.toLowerCase();
    let sendTo: string;
    let destinationKind: "vendor_contact_email" | "account_email";
    if (vendorEmail && !emailsMatch) {
      sendTo = vendor.contactEmail as string;
      destinationKind = "vendor_contact_email";
    } else if (emailsMatch) {
      sendTo = user.email;
      destinationKind = "account_email";
    } else {
      // contact_email is null/empty: refuse, with a route to admin override.
      return NextResponse.json(
        {
          error: "vendor_has_no_contact_email",
          message:
            "This listing has no contact email on file, so we can't send a verification to verify business ownership. Please contact support — an admin can approve the claim manually.",
        },
        { status: 422 }
      );
    }

    const { rawToken } = await createClaimToken(db, {
      vendorId: vendor.id,
      userId: session.user.id,
    });
    const verifyUrl = `${getSiteUrl()}/api/vendor/claim/confirm?token=${rawToken}`;
    const tpl = vendorClaimVerificationTemplate({
      businessName: vendor.businessName,
      verifyUrl,
    });
    await enqueueEmail({ to: sendTo, ...tpl, source: "vendor.claim-initiate" });

    return NextResponse.json({
      ok: true,
      // Surface a masked destination so the UI can render "We sent
      // a confirmation to in***@yourbusiness.com — click the link
      // in that email to finish claiming." Don't reveal the full
      // address in case the user typed it from somewhere they
      // shouldn't have.
      destination: maskEmail(sendTo),
      destinationKind,
    });
  } catch (e) {
    await logError(db, {
      message: "Vendor claim initiate failed",
      error: e,
      source: "api/vendor/claim/initiate",
    });
    return NextResponse.json({ error: "Failed to initiate claim" }, { status: 500 });
  }
}
