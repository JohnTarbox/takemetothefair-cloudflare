/**
 * Daily sweep that processes Enhanced Profile vendors past their 30-day
 * grace period. Cloudflare doesn't have cron triggers configured here
 * (per project memory feedback_no_cron_triggers.md), so this endpoint is
 * the substitute — admin runs it manually or wires an external scheduler
 * (cron-job.org / Make.com / GitHub Actions cron) to POST against it.
 *
 * What "past grace" means:
 *   enhanced_profile = 1 AND enhanced_profile_expires_at + 30 days < now
 *
 * For each match, the row is flipped to enhanced_profile=0, verified=0.
 * gallery_images is intentionally PRESERVED so re-activation can restore
 * the prior state with no data loss. Slug and slug history are also
 * preserved.
 *
 * Auth: admin session OR X-Internal-Key header.
 */
import { NextResponse } from "next/server";
import { eq, and, isNotNull, lt } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendors, adminActions } from "@/lib/db/schema";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

export const runtime = "edge";

const GRACE_MS = 30 * 86400000;

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
  const now = new Date();
  const cutoff = new Date(now.getTime() - GRACE_MS);

  try {
    // Find vendors whose grace period has fully elapsed.
    const expired = await db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        businessName: vendors.businessName,
        expiresAt: vendors.enhancedProfileExpiresAt,
      })
      .from(vendors)
      .where(
        and(
          eq(vendors.enhancedProfile, true),
          isNotNull(vendors.enhancedProfileExpiresAt),
          lt(vendors.enhancedProfileExpiresAt, cutoff)
        )
      );

    if (expired.length === 0) {
      return NextResponse.json({ success: true, processed: 0, vendors: [] });
    }

    // Flip each one. Per-row updates rather than a bulk WHERE so the audit
    // log can capture the previous expires_at for forensics later.
    for (const v of expired) {
      await db
        .update(vendors)
        .set({ enhancedProfile: false, verified: false, updatedAt: now })
        .where(eq(vendors.id, v.id));

      await db.insert(adminActions).values({
        action: "enhanced_profile.auto_expire",
        actorUserId: null, // system-driven
        targetType: "vendor",
        targetId: v.id,
        payloadJson: JSON.stringify({
          previous_expires_at: v.expiresAt,
          grace_cutoff: cutoff.toISOString(),
        }),
        createdAt: now,
      });

      // Ping IndexNow so search engines re-index the now-downgraded profile.
      await pingIndexNow(db, indexNowUrlFor("vendors", v.slug), env, "vendor-update");
    }

    return NextResponse.json({
      success: true,
      processed: expired.length,
      vendors: expired.map((v) => ({
        id: v.id,
        slug: v.slug,
        businessName: v.businessName,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "internal_error", message }, { status: 500 });
  }
}
