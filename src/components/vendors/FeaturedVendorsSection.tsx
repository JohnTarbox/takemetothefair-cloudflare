import Link from "next/link";
import Image from "next/image";
import { Store, CheckCircle, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { rotateFeaturedVendors } from "@/lib/featured-rotation";

export interface FeaturedVendor {
  id: string;
  businessName: string;
  slug: string;
  vendorType: string | null;
  city: string | null;
  state: string | null;
  logoUrl: string | null;
  featuredPriority: number | null;
}

interface Props {
  vendors: FeaturedVendor[];
  /** Optional override for testing — defaults to today's UTC date. */
  date?: Date;
}

/**
 * Server component. Section appears above the alphabetical grid on
 * /vendors and category-filtered views. Caller is responsible for
 * pre-filtering to only `enhanced_profile = 1` vendors and (optionally)
 * to the current category. Renders nothing if the input is empty so
 * empty filtered views drop the section entirely.
 */
export function FeaturedVendorsSection({ vendors, date }: Props) {
  if (vendors.length === 0) return null;
  const rotated = rotateFeaturedVendors(vendors, { topN: 6, date });

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-5 h-5 text-amber" />
        <h2 className="text-lg font-semibold text-gray-900">Featured Vendors</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {rotated.map((v) => (
          <Card
            key={v.id}
            className="overflow-hidden border-amber/40 bg-amber/5 hover:border-amber transition-colors relative"
          >
            <div className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-amber/90 text-navy text-xs font-medium px-2 py-0.5">
              Featured
            </div>
            <Link href={`/vendors/${v.slug}`} className="block p-4">
              <div className="flex gap-3">
                <div className="w-20 h-20 rounded-lg bg-white flex items-center justify-center relative overflow-hidden flex-shrink-0">
                  {v.logoUrl ? (
                    <Image
                      src={v.logoUrl}
                      alt={`${v.businessName} logo`}
                      fill
                      sizes="80px"
                      className="object-cover"
                    />
                  ) : (
                    <Store className="w-10 h-10 text-gray-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="font-semibold text-gray-900 truncate">{v.businessName}</h3>
                    <CheckCircle
                      className="w-4 h-4 text-royal flex-shrink-0"
                      aria-label="Verified"
                    />
                  </div>
                  {v.vendorType && <p className="text-xs text-gray-600 mt-0.5">{v.vendorType}</p>}
                  {(v.city || v.state) && (
                    <p className="text-xs text-gray-500 mt-1">
                      {[v.city, v.state].filter(Boolean).join(", ")}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          </Card>
        ))}
      </div>
    </section>
  );
}
