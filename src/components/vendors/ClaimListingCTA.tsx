import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { decodeHtmlEntities } from "@/lib/utils";
import { DirectClaimButton } from "./DirectClaimButton";

interface Props {
  businessName: string;
  vendorSlug: string;
  /** Vendor row id — forwarded to the claim-funnel `vendor_id` param. */
  vendorId?: string;
  /**
   * Set true by the parent page when the signed-in visitor's verified
   * email matches the vendor's contact_email. In that case we render a
   * client-side one-click claim button (POST /api/vendor/claim/direct);
   * otherwise we fall back to the original /register?claim=<slug>
   * link, which handles both "not signed in yet" and "signed in but
   * email doesn't match" cases.
   */
  eligibleForDirectClaim?: boolean;
}

// Public CTA on unclaimed vendor pages. Two render branches:
//  - direct-claim eligible: client-side button, one-click claim
//  - everyone else: server-side link to /register?claim=<slug>, which
//    handles the placeholder-takeover at signup time.
// Renders only when !claimed && !isOwner && !isAdmin (gated in the
// parent page).
export function ClaimListingCTA({
  businessName,
  vendorSlug,
  vendorId,
  eligibleForDirectClaim,
}: Props) {
  const decoded = decodeHtmlEntities(businessName);
  // OPE-64 — the fallback now points at the claim WIZARD (preview → account →
  // verify) instead of jumping straight into /register. The wizard handles both
  // "not signed in" (its account step links to register/login) and "signed in
  // but no automatic match" (evidence). The direct-claim shortcut below is kept
  // for the verified-email-match one-click path.
  const fallbackHref = `/claim/vendor/${encodeURIComponent(vendorSlug)}`;

  return (
    <Card className="border-amber-dark/30 bg-amber-light">
      <CardContent className="p-5 flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-amber-dark flex-shrink-0 mt-1" aria-hidden />
        <div className="flex-1">
          <h3 className="font-semibold text-stone-900">Is this your business?</h3>
          <p className="text-sm text-stone-700 mt-1">
            {eligibleForDirectClaim
              ? `Your account email matches the contact email on this listing — we can confirm ownership in one click.`
              : `Claim ${decoded} for free to add a description, photos, and contact info — and help customers find you when they search.`}
          </p>
          {eligibleForDirectClaim ? (
            <DirectClaimButton vendorSlug={vendorSlug} vendorId={vendorId} />
          ) : (
            <Link href={fallbackHref} rel="nofollow" className="mt-3 inline-block">
              <Button size="sm">Claim this free listing</Button>
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
