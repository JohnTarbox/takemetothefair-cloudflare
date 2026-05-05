// Positive-only badges per §6.6 framework. Claimed signals "the business
// itself maintains this listing"; Enhanced Profile signals an active paid
// subscription. Render order is Claimed first then Enhanced — earned-trust
// gradient. No badge appears on STUB or MENTION (absence is the signal).

import { Badge } from "@/components/ui/badge";
import { CheckCircle, Star } from "lucide-react";

interface VendorTierBadgesProps {
  claimed?: boolean | null;
  enhancedProfile?: boolean | null;
  /** Optional className applied to the container wrapping both badges. */
  className?: string;
  /** Smaller variant for use inside listing cards. */
  size?: "sm" | "md";
}

export function VendorTierBadges({
  claimed,
  enhancedProfile,
  className,
  size = "md",
}: VendorTierBadgesProps) {
  if (!claimed && !enhancedProfile) return null;
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
    </span>
  );
}
