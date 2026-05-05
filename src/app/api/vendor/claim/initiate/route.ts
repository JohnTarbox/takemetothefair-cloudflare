import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users } from "@/lib/db/schema";
import { createClaimToken } from "@/lib/vendor-claim-token";
import { sendEmail, getSiteUrl } from "@/lib/email/send";
import { vendorClaimVerificationTemplate } from "@/lib/email/templates";
import { logError } from "@/lib/logger";

export const runtime = "edge";

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

    const { rawToken } = await createClaimToken(db, {
      vendorId: vendor.id,
      userId: session.user.id,
    });
    const verifyUrl = `${getSiteUrl()}/api/vendor/claim/confirm?token=${rawToken}`;
    const tpl = vendorClaimVerificationTemplate({
      businessName: vendor.businessName,
      verifyUrl,
    });
    await sendEmail(db, { to: user.email, ...tpl });

    return NextResponse.json({ ok: true });
  } catch (e) {
    await logError(db, {
      message: "Vendor claim initiate failed",
      error: e,
      source: "api/vendor/claim/initiate",
    });
    return NextResponse.json({ error: "Failed to initiate claim" }, { status: 500 });
  }
}
