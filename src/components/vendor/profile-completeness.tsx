import Link from "next/link";
import { CheckCircle2, AlertCircle, TrendingUp } from "lucide-react";
import { eq, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors } from "@/lib/db/schema";
import { computeVendorCompleteness } from "@/lib/vendor-completeness";

interface Props {
  userId: string;
}

/**
 * Server component. Fetches the vendor profile + tier-relevant fields and
 * renders a completeness nudge (5-field bar) plus the §6.6 tier-gap section.
 * Returns null when the user has no vendor record (e.g. admins viewing
 * vendor pages) or is at ENHANCED with the 5-field bar already at 100%.
 */
export async function VendorProfileCompleteness({ userId }: Props) {
  let vendor;
  let eventCount = 0;
  try {
    const db = getCloudflareDb();
    vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
      columns: {
        id: true,
        logoUrl: true,
        description: true,
        products: true,
        contactEmail: true,
        contactPhone: true,
        city: true,
        state: true,
        website: true,
        socialLinks: true,
        enhancedProfile: true,
      },
    });
    if (vendor) {
      const [counts] = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(eventVendors)
        .where(eq(eventVendors.vendorId, vendor.id));
      eventCount = Number(counts?.n ?? 0);
    }
  } catch {
    return null;
  }

  if (!vendor) return null;

  const { percent, missing, complete, currentTier, nextTier, tierGap, nextTierAction } =
    computeVendorCompleteness({ ...vendor, eventAssociationCount: eventCount });

  // Render nothing if both the 5-field bar is full AND tier is at the top.
  if (complete && currentTier === "ENHANCED") return null;

  const nextToAdd = missing[0];
  const fillClass = percent < 40 ? "bg-terracotta" : percent < 80 ? "bg-amber" : "bg-sage-700";

  return (
    <div className="mb-6 rounded-lg border border-stone-100 bg-stone-50 p-4 space-y-4">
      {!complete && (
        <div className="flex items-start gap-3">
          {percent >= 80 ? (
            <CheckCircle2 className="w-5 h-5 text-sage-700 flex-shrink-0 mt-0.5" aria-hidden />
          ) : (
            <AlertCircle className="w-5 h-5 text-amber-dark flex-shrink-0 mt-0.5" aria-hidden />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-stone-900">
                Your vendor profile is {percent}% complete
              </p>
              <Link
                href="/vendor/profile"
                className="text-sm font-medium text-navy hover:underline"
              >
                Finish profile
              </Link>
            </div>
            <div
              className="mt-2 h-1.5 rounded-full bg-stone-100 overflow-hidden"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Profile completeness"
            >
              <div
                className={`h-full ${fillClass} transition-all`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 text-sm text-stone-600">
              Promoters are more likely to approve your applications when your profile is complete.
              Add your <strong className="text-stone-900">{nextToAdd}</strong>
              {missing.length > 1 && (
                <>
                  {" "}
                  ({missing.length - 1} more field{missing.length - 1 > 1 ? "s" : ""} remaining)
                </>
              )}
              .
            </p>
          </div>
        </div>
      )}

      {nextTierAction === "fill_fields" && tierGap.length > 0 && (
        <div className="flex items-start gap-3 border-t border-stone-100 pt-4">
          <TrendingUp className="w-5 h-5 text-navy flex-shrink-0 mt-0.5" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-stone-900">
              Reach {nextTier} tier and appear in search results
            </p>
            <p className="mt-1 text-sm text-stone-600">
              Vendors with complete profiles see roughly 3× the click-through rate. Add your{" "}
              <strong className="text-stone-900">{tierGap.join(", ")}</strong> to qualify.
            </p>
            <Link
              href="/vendor/profile"
              className="mt-2 inline-block text-sm font-medium text-navy hover:underline"
            >
              Update profile →
            </Link>
          </div>
        </div>
      )}

      {nextTierAction === "upgrade_to_enhanced" && (
        <div className="flex items-start gap-3 border-t border-stone-100 pt-4">
          <TrendingUp className="w-5 h-5 text-amber-dark flex-shrink-0 mt-0.5" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-stone-900">
              You qualify for the sitemap. Upgrade to Enhanced Profile for higher placement.
            </p>
            <p className="mt-1 text-sm text-stone-600">
              Enhanced Profile vendors get a Featured badge, gallery photos, and weekly sitemap
              refresh. Vendors with complete profiles see roughly 3× the click-through rate.
            </p>
            <Link
              href="/vendor/profile"
              className="mt-2 inline-block text-sm font-medium text-navy hover:underline"
            >
              Learn about Enhanced Profile →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
