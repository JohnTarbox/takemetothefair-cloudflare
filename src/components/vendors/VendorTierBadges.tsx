// Positive-only badges per §6.6 framework. Render order is Claimed → Enhanced
// → Verified Pro (earned-trust gradient). No badge appears on a vendor that
// has none of the three signals (absence is the default).

import { Badge } from "@/components/ui/badge";
import { CheckCircle, Star, Shield } from "lucide-react";

interface VendorTierBadgesProps {
  claimed?: boolean | null;
  enhancedProfile?: boolean | null;
  verifiedPro?: boolean | null;
  /** Optional className applied to the container wrapping the badges. */
  className?: string;
  /** Smaller variant for use inside listing cards. */
  size?: "sm" | "md";
}

export function VendorTierBadges({
  claimed,
  enhancedProfile,
  verifiedPro,
  className,
  size = "md",
}: VendorTierBadgesProps) {
  if (!claimed && !enhancedProfile && !verifiedPro) return null;
  const iconSize = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";
  return (
    <span className={className} role="group" aria-label="Vendor trust badges">
      {claimed && (
        <Badge
          variant="info"
          className="gap-1"
          title="The business itself maintains this listing."
          aria-label="Claimed listing"
        >
          <CheckCircle className={iconSize} />
          Claimed
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
