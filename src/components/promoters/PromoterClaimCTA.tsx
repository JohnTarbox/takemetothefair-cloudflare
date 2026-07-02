import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { decodeHtmlEntities } from "@/lib/utils";

interface Props {
  companyName: string;
  promoterSlug: string;
}

// Public CTA on unclaimed promoter pages (OPE-61) — the promoter analog of
// ClaimListingCTA. Links to /register?role=PROMOTER&companyName=…&claim=<slug>,
// which resolves the claim SAFELY at signup (email-match → approved, else
// PENDING evidence).
//
// rel="nofollow" is REQUIRED (OPE-43): register URLs must not be harvested by
// crawlers (Bingbot in particular).
//
// Rendered only when !claimed && !isOwner && !isAdmin (gated in the parent page).
export function PromoterClaimCTA({ companyName, promoterSlug }: Props) {
  const decoded = decodeHtmlEntities(companyName);
  const href = `/register?role=PROMOTER&companyName=${encodeURIComponent(decoded)}&claim=${encodeURIComponent(promoterSlug)}`;

  return (
    <Card className="border-amber-dark/30 bg-amber-light">
      <CardContent className="p-5 flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-amber-dark flex-shrink-0 mt-1" aria-hidden />
        <div className="flex-1">
          <h3 className="font-semibold text-stone-900">Is this your organization?</h3>
          <p className="text-sm text-stone-700 mt-1">
            Claim {decoded} free to manage your events and vendor applications.
          </p>
          <Link href={href} rel="nofollow" className="mt-3 inline-block">
            <Button size="sm">Claim this free listing</Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
