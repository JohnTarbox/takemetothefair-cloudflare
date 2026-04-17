import Link from "next/link";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors } from "@/lib/db/schema";
import { computeVendorCompleteness } from "@/lib/vendor-completeness";

interface Props {
  userId: string;
}

/**
 * Server component. Fetches the vendor profile and renders a completeness
 * nudge bar when the profile is below 100%. Returns null when the user has
 * no vendor record (e.g. admins viewing vendor pages) or is already complete.
 */
export async function VendorProfileCompleteness({ userId }: Props) {
  let vendor;
  try {
    const db = getCloudflareDb();
    vendor = await db.query.vendors.findFirst({
      where: eq(vendors.userId, userId),
      columns: {
        logoUrl: true,
        description: true,
        products: true,
        contactEmail: true,
        contactPhone: true,
        city: true,
        state: true,
      },
    });
  } catch {
    return null;
  }

  if (!vendor) return null;

  const { percent, missing, complete } = computeVendorCompleteness(vendor);
  if (complete) return null;

  const nextToAdd = missing[0];
  const fillClass = percent < 40 ? "bg-terracotta" : percent < 80 ? "bg-amber" : "bg-sage-700";

  return (
    <div className="mb-6 rounded-lg border border-stone-100 bg-stone-50 p-4">
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
            <Link href="/vendor/profile" className="text-sm font-medium text-navy hover:underline">
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
    </div>
  );
}
