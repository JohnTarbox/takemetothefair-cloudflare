import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { decodeHtmlEntities } from "@/lib/utils";
import { DirectClaimButton } from "./DirectClaimButton";

interface Props {
  performerName: string;
  performerSlug: string;
  /**
   * Set true by the parent page when the signed-in visitor's email matches the
   * act's contact_email. In that case we render the one-click claim button
   * (POST /api/performer/claim/direct); otherwise we show a prompt to sign in
   * with the listed email or contact support (there is no token/cold-invite
   * wizard for performers yet — operator approval covers the mismatch case).
   */
  eligibleForDirectClaim?: boolean;
}

// Public CTA on unclaimed performer pages. Rendered only when
// !claimed && !isOwner && !isAdmin (gated in the parent page).
export function ClaimListingCTA({ performerName, performerSlug, eligibleForDirectClaim }: Props) {
  const decoded = decodeHtmlEntities(performerName);

  return (
    <Card className="border-amber-dark/30 bg-amber-light">
      <CardContent className="p-5 flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-amber-dark flex-shrink-0 mt-1" aria-hidden />
        <div className="flex-1">
          <h3 className="font-semibold text-stone-900">Is this your act?</h3>
          <p className="text-sm text-stone-700 mt-1">
            {eligibleForDirectClaim
              ? `Your account email matches the contact email on this listing — you can confirm ownership in one click.`
              : `Claim ${decoded} to manage your bio, photo, links, and appearance schedule. Sign in with the email on file for this act to claim it in one click, or contact us to verify ownership another way.`}
          </p>
          {eligibleForDirectClaim && <DirectClaimButton performerSlug={performerSlug} />}
        </div>
      </CardContent>
    </Card>
  );
}
