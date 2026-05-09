import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { decodeHtmlEntities } from "@/lib/utils";

interface Props {
  businessName: string;
  vendorSlug: string;
}

// Public CTA on unclaimed vendor pages — converts skeleton listings (which
// are noindex'd by the §6.6 SEO gate) from dead weight into a vendor
// acquisition funnel. Click lands on /register pre-filled with the existing
// row's businessName + the slug as `claim`, so the register API can
// transfer ownership of the placeholder vendor row instead of creating a
// duplicate. Renders only when !claimed && !isOwner && !isAdmin.
export function ClaimListingCTA({ businessName, vendorSlug }: Props) {
  const decoded = decodeHtmlEntities(businessName);
  const href = `/register?role=VENDOR&businessName=${encodeURIComponent(decoded)}&claim=${encodeURIComponent(vendorSlug)}`;
  return (
    <Card className="border-amber-dark/30 bg-amber-light">
      <CardContent className="p-5 flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-amber-dark flex-shrink-0 mt-1" aria-hidden />
        <div className="flex-1">
          <h3 className="font-semibold text-stone-900">Is this your business?</h3>
          <p className="text-sm text-stone-700 mt-1">
            Claim {decoded} to add a description, photos, and contact info — and help customers find
            you when they search.
          </p>
          <Link href={href} className="mt-3 inline-block">
            <Button size="sm">Claim this listing</Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
