"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { CheckCircle, Calendar, MapPin } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parseJsonArray } from "@/types";
import { formatDateRange } from "@/lib/utils";
import { FavoriteButton } from "@/components/FavoriteButton";
import { VendorTierBadges } from "./VendorTierBadges";
import { cdnImage, focalPointGravity } from "@/lib/cdn-image";
import { VendorMonogramLogo } from "./VendorMonogramLogo";
import {
  displayVendorName,
  type ParentDisplayInput,
  type VendorDisplayInput,
} from "@takemetothefair/utils";

interface VendorEvent {
  id: string;
  name: string;
  slug: string;
  startDate: Date | null;
  endDate: Date | null;
  imageUrl: string | null;
  venue: {
    name: string;
    city: string | null;
    state: string | null;
  } | null;
}

interface VendorCardProps {
  vendor: {
    id: string;
    businessName: string;
    /** EH2.1 — optional brand display override (vendors.display_name). */
    displayName?: string | null;
    slug: string;
    description: string | null;
    vendorType: string | null;
    products: string | null;
    logoUrl: string | null;
    imageFocalX?: number;
    imageFocalY?: number;
    verified: boolean | null;
    commercial: boolean | null;
    claimed?: boolean | null;
    enhancedProfile?: boolean | null;
    verifiedPro?: boolean | null;
    city?: string | null;
    state?: string | null;
    /** EH1 hierarchy fields — optional; when omitted the helper resolves
     *  to the row's own self-name. Populated by PR EH2.2's listing JOIN. */
    role?: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
    brandParentVendorId?: string | null;
    operatorParentVendorId?: string | null;
    aliasOfVendorId?: string | null;
    displayOverridePermitted?: boolean;
    displayMode?: "inherit" | "self" | "brand_parent" | "operator_parent" | "both" | null;
    events: VendorEvent[];
  };
  /** EH1 brand parent for gate-aware name resolution. Optional — the helper
   *  falls back to the office's own name when not provided. */
  brandParent?: ParentDisplayInput | null;
  /** EH1 operator parent for the rare operator_parent display mode. */
  operatorParent?: ParentDisplayInput | null;
}

export function VendorCard({ vendor, brandParent, operatorParent }: VendorCardProps) {
  const [logoError, setLogoError] = useState(false);
  const products = parseJsonArray(vendor.products);
  // EH2.1 — resolved name honors display_name override + brand_parent gate.
  // For INDEPENDENT rows (~99%) with no display_name, the result is bit-
  // identical to vendor.businessName so rendered HTML / cache keys are
  // unchanged. VendorMonogramLogo intentionally still reads the raw
  // businessName because the monogram represents row identity, not the
  // resolved brand surface.
  const vendorInput: VendorDisplayInput = {
    role: vendor.role ?? "INDEPENDENT",
    brandParentVendorId: vendor.brandParentVendorId ?? null,
    operatorParentVendorId: vendor.operatorParentVendorId ?? null,
    aliasOfVendorId: vendor.aliasOfVendorId ?? null,
    displayOverridePermitted: vendor.displayOverridePermitted ?? false,
    displayMode: vendor.displayMode ?? null,
    businessName: vendor.businessName,
    displayName: vendor.displayName ?? null,
  };
  const resolvedName = displayVendorName(vendorInput, brandParent, operatorParent);

  return (
    <Card className="overflow-hidden">
      <div className="p-6">
        <div className="flex gap-4">
          <Link href={`/vendors/${vendor.slug}`} className="flex-shrink-0">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center relative overflow-hidden hover:opacity-80 transition-opacity">
              {vendor.logoUrl && !logoError ? (
                // IMG1 §1b Phase 1 (2026-06-08) — server-side fit=cover
                // + per-image focal point. 64px slot, so 1x/2x DPR
                // variants. For square logos the focal point is no-op
                // (matches default center crop), but non-square uploads
                // get rescued via the admin focal-point picker.
                (() => {
                  const gravity = focalPointGravity(vendor.imageFocalX, vendor.imageFocalY);
                  const srcSet = [64, 128]
                    .map(
                      (w) =>
                        `${cdnImage(vendor.logoUrl!, {
                          width: w,
                          height: w,
                          fit: "cover",
                          ...(gravity ? { gravity } : {}),
                          format: "auto",
                          quality: 80,
                          onerror: "redirect",
                        })} ${w}w`
                    )
                    .join(", ");
                  const src = cdnImage(vendor.logoUrl, {
                    width: 64,
                    height: 64,
                    fit: "cover",
                    ...(gravity ? { gravity } : {}),
                    format: "auto",
                    quality: 80,
                    onerror: "redirect",
                  });
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={src}
                      srcSet={srcSet}
                      sizes="64px"
                      alt={`${resolvedName} logo`}
                      width={64}
                      height={64}
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={() => setLogoError(true)}
                    />
                  );
                })()
              ) : (
                /* UX-A2 Part A — monogram tile instead of generic Store
                   icon when no logo uploaded. Keeps listing grid visually
                   coherent with the detail-page change. */
                <VendorMonogramLogo
                  businessName={vendor.businessName}
                  size={64}
                  className="!rounded-lg"
                />
              )}
            </div>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/vendors/${vendor.slug}`} className="hover:text-navy">
                <h3 className="font-semibold text-foreground truncate">{resolvedName}</h3>
              </Link>
              {vendor.verified && <CheckCircle className="w-4 h-4 text-royal flex-shrink-0" />}
              <VendorTierBadges
                claimed={vendor.claimed}
                enhancedProfile={vendor.enhancedProfile}
                verifiedPro={vendor.verifiedPro}
                className="inline-flex items-center gap-1"
                size="sm"
              />
              {vendor.commercial && <Badge variant="default">Commercial</Badge>}
              <FavoriteButton type="VENDOR" id={vendor.id} className="ml-auto" size="sm" />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
              {vendor.vendorType && <span>{vendor.vendorType}</span>}
              {vendor.vendorType && (vendor.city || vendor.state) && <span>•</span>}
              {(vendor.city || vendor.state) && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {[vendor.city, vendor.state].filter(Boolean).join(", ")}
                </span>
              )}
            </div>
            {vendor.description && (
              <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                {vendor.description}
              </p>
            )}
            {products.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {products.slice(0, 3).map((product) => (
                  <Badge key={product} variant="default">
                    {product}
                  </Badge>
                ))}
                {products.length > 3 && <Badge variant="default">+{products.length - 3}</Badge>}
              </div>
            )}
          </div>
        </div>

        {/* Events Grid */}
        {vendor.events.length > 0 && (
          <div className="mt-6 pt-6 border-t border-border">
            <h4 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              Upcoming Events ({vendor.events.length})
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {vendor.events.map((event) => (
                <Link
                  key={event.id}
                  href={`/events/${event.slug}`}
                  className="block p-3 bg-muted rounded-lg hover:bg-muted transition-colors"
                >
                  {event.imageUrl && (
                    <div className="aspect-video rounded-md overflow-hidden mb-2 relative">
                      <Image
                        src={event.imageUrl}
                        alt={`Photo of ${event.name} event`}
                        fill
                        sizes="(max-width: 640px) 100vw, 200px"
                        className="object-cover"
                      />
                    </div>
                  )}
                  <p className="font-medium text-foreground text-sm truncate">{event.name}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatDateRange(event.startDate, event.endDate)}
                  </p>
                  {event.venue && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      <MapPin className="w-3 h-3" />
                      {event.venue.city}, {event.venue.state}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        {vendor.events.length === 0 && (
          <p className="mt-4 text-xs text-muted-foreground">No upcoming events scheduled</p>
        )}
      </div>
    </Card>
  );
}
