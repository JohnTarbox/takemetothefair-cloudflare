import Link from "next/link";
import Image from "next/image";
import { Store, CheckCircle, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { rotateFeaturedVendors } from "@/lib/featured-rotation";
import { VendorTierBadges } from "./VendorTierBadges";

export interface FeaturedVendor {
  id: string;
  businessName: string;
  slug: string;
  vendorType: string | null;
  city: string | null;
  state: string | null;
  logoUrl: string | null;
  featuredPriority: number | null;
  claimed?: boolean | null;
  enhancedProfile?: boolean | null;
  verifiedPro?: boolean | null;
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
        <Sparkles className="w-5 h-5 text-amber-fg" />
        <h2 className="text-lg font-semibold text-foreground">Featured Vendors</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {rotated.map((v) => (
          <Card
            key={v.id}
            className="overflow-hidden border-amber/40 bg-amber/5 hover:border-amber transition-colors relative"
          >
            {/* UX-R3 (2026-06-04): use the brand-canonical "text on amber"
                pair for AAA-grade legibility on the amber surface.
                Contrast follow-up (2026-06-07): migrated from text-amber-bg-fg
                to text-primary-foreground. Same hex (#1F1A0A) in light mode,
                but text-amber-bg-fg flips to a light value in dark mode to
                serve the bg-amber-light pill consumers (18 callers), which
                fails on solid bg-amber. text-primary-foreground stays #1F1A0A
                always — correct for "text on vibrant amber" always. */}
            <div className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-amber/90 text-primary-foreground text-xs font-medium px-2 py-0.5">
              Featured
            </div>
            <Link href={`/vendors/${v.slug}`} className="block p-4">
              <div className="flex gap-3">
                <div className="w-20 h-20 rounded-lg bg-card flex items-center justify-center relative overflow-hidden flex-shrink-0">
                  {v.logoUrl ? (
                    <Image
                      src={v.logoUrl}
                      alt={`${v.businessName} logo`}
                      fill
                      sizes="80px"
                      className="object-cover"
                    />
                  ) : (
                    <Store className="w-10 h-10 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <h3 className="font-semibold text-foreground truncate">{v.businessName}</h3>
                    <CheckCircle
                      className="w-4 h-4 text-royal flex-shrink-0"
                      aria-label="Verified"
                    />
                    <VendorTierBadges
                      claimed={v.claimed}
                      enhancedProfile={v.enhancedProfile}
                      verifiedPro={v.verifiedPro}
                      className="inline-flex items-center gap-1"
                      size="sm"
                    />
                  </div>
                  {v.vendorType && (
                    <p className="text-xs text-muted-foreground mt-0.5">{v.vendorType}</p>
                  )}
                  {(v.city || v.state) && (
                    <p className="text-xs text-muted-foreground mt-1">
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
