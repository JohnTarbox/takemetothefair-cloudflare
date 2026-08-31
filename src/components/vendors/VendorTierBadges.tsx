// Positive-only badges per §6.6 framework. Render order is Owner-confirmed →
// Enhanced → Verified Pro (earned-trust gradient). No badge appears on a vendor
// that has none of the three signals (absence is the default).
//
// OPE-238 — the first badge used to be "Claimed" and rendered off
// `vendors.claimed` alone, with no verification condition. A claim became
// public the instant somebody registered, while their email was still
// unconfirmed: 26 of 73 claimants had never confirmed an address. It now
// renders "Owner-confirmed" and requires BOTH the claim and a verified owner
// email — see `isOwnerConfirmed` in src/lib/claims/owner-confirmed.ts, which
// is where that conjunction lives so the three call sites cannot disagree.
//
// "Verified" is deliberately NOT reused for this: it already means the paid
// Enhanced Profile tier below, and a shopper cannot be asked to tell two
// different "verified"s apart. Ruled by John, 2026-08-31.

import { Badge } from "@/components/ui/badge";
import { CheckCircle, Star, Shield } from "lucide-react";

interface VendorTierBadgesProps {
  /**
   * Claimed AND the owner's email is confirmed. Compute with `isOwnerConfirmed`
   * rather than passing `vendor.claimed` — passing the raw claim flag is the
   * defect OPE-238 fixed, and the prop was renamed so that mistake cannot be
   * made silently by a caller that was never updated.
   */
  ownerConfirmed?: boolean | null;
  enhancedProfile?: boolean | null;
  verifiedPro?: boolean | null;
  /** Optional className applied to the container wrapping the badges. */
  className?: string;
  /** Smaller variant for use inside listing cards. */
  size?: "sm" | "md";
}

export function VendorTierBadges({
  ownerConfirmed,
  enhancedProfile,
  verifiedPro,
  className,
  size = "md",
}: VendorTierBadgesProps) {
  if (!ownerConfirmed && !enhancedProfile && !verifiedPro) return null;
  const iconSize = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";
  return (
    <span className={className} role="group" aria-label="Vendor trust badges">
      {ownerConfirmed && (
        <Badge
          variant="info"
          className="gap-1"
          title="The business confirmed ownership of this listing from its own email address."
          aria-label="Owner-confirmed listing"
        >
          <CheckCircle className={iconSize} />
          Owner-confirmed
        </Badge>
      )}
      {enhancedProfile && (
        <Badge
          variant="success"
          className="gap-1"
          title="This vendor has a verified Enhanced Profile on Meet Me at the Fair."
          aria-label="Enhanced Profile vendor"
        >
          <Star className={iconSize} />
          Enhanced
        </Badge>
      )}
      {verifiedPro && (
        <Badge
          variant="info"
          className="gap-1 bg-amber/20 text-navy ring-1 ring-amber/40"
          title="Identity verified by Meet Me at the Fair."
          aria-label="Verified Pro vendor"
        >
          <Shield className={iconSize} />
          Verified Pro
        </Badge>
      )}
    </span>
  );
}
