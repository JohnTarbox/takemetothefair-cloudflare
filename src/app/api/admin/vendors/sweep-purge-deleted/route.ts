export const dynamic = "force-dynamic";
/**
 * Daily sweep that hard-purges vendors whose soft-delete grace window
 * (30 days) has elapsed. Mirrors sweep-enhanced pattern (per project memory
 * feedback_no_cron_triggers.md — admin runs it manually or wires an
 * external scheduler).
 *
 * For each vendor with deleted_at < now - 30 days:
 *   - Delete content_links rows targeting this vendor (polymorphic, no FK)
 *   - Delete recommendation_items rows targeting this vendor (polymorphic, no FK)
 *   - DELETE FROM vendors → CASCADE removes event_vendors, vendor_slug_history
 *     (both have ON DELETE CASCADE). NOTE (OPE-63): the old vendor_claim_tokens
 *     table is now the polymorphic claim_tokens with NO FK to vendors, so its
 *     rows no longer cascade — harmless here (0 tokens have ever been issued).
 *   - SET NULL on any other vendor's redirect_to_vendor_id pointing here
 *     (per migration 0053 ON DELETE SET NULL policy)
 *   - Audit log row (action='vendor.purge', actor=null for system-driven)
 *   - IndexNow ping (search engines re-discover the 410)
 *
 * Auth: admin session OR X-Internal-Key header.
 */
import { NextResponse } from "next/server";
import { eq, and, isNotNull, lt } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { vendors, adminActions, contentLinks, recommendationItems } from "@/lib/db/schema";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

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
    const expired = await db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        businessName: vendors.businessName,
        deletedAt: vendors.deletedAt,
        enhancedProfile: vendors.enhancedProfile,
        claimed: vendors.claimed,
        verifiedPro: vendors.verifiedPro,
      })
      .from(vendors)
      .where(and(isNotNull(vendors.deletedAt), lt(vendors.deletedAt, cutoff)));

    if (expired.length === 0) {
      return NextResponse.json({ success: true, processed: 0, vendors: [] });
    }

    for (const v of expired) {
      // Polymorphic refs (no FK to cascade): clean up before vendor row delete.
      const contentLinksDeleted = await db
        .delete(contentLinks)
        .where(and(eq(contentLinks.targetType, "VENDOR"), eq(contentLinks.targetId, v.id)))
        .returning({ id: contentLinks.id });

      const recommendationsDeleted = await db
        .delete(recommendationItems)
        .where(
          and(eq(recommendationItems.targetType, "vendor"), eq(recommendationItems.targetId, v.id))
        )
        .returning({ id: recommendationItems.id });

      // FK CASCADE handles: event_vendors, vendor_slug_history.
      // FK SET NULL handles: any other vendor's redirect_to_vendor_id pointing here.
      // (claim_tokens is polymorphic post-OPE-63 — no FK, no cascade; 0 rows.)
      await db.delete(vendors).where(eq(vendors.id, v.id));

      await db.insert(adminActions).values({
        action: "vendor.purge",
        actorUserId: null,
        targetType: "vendor",
        targetId: v.id,
        payloadJson: JSON.stringify({
          via: "sweep-purge-deleted",
          deleted_at: v.deletedAt?.toISOString() ?? null,
          grace_cutoff: cutoff.toISOString(),
          vendor_snapshot: {
            slug: v.slug,
            business_name: v.businessName,
            enhanced_profile: v.enhancedProfile,
            claimed: v.claimed,
            verified_pro: v.verifiedPro,
          },
          content_links_deleted: contentLinksDeleted.length,
          recommendations_deleted: recommendationsDeleted.length,
        }),
        createdAt: now,
      });

      await pingIndexNow(db, indexNowUrlFor("vendors", v.slug), env, "vendor-purge");
    }

    return NextResponse.json({
      success: true,
      processed: expired.length,
      vendors: expired.map((v) => ({ id: v.id, slug: v.slug, businessName: v.businessName })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "internal_error", message }, { status: 500 });
  }
}
