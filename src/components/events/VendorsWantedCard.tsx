import { Store } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { OutboundEventLink } from "@/components/OutboundEventLink";
import type { VendorCallView } from "@/lib/events/vendor-call";

interface Props {
  call: VendorCallView;
  eventSlug: string;
}

/** OPE-1512 item 4 — the public "Vendors wanted" card. See `vendor-call.ts`. */
export function VendorsWantedCard({ call, eventSlug }: Props) {
  const showTerms = call.closesOn || call.fee;
  return (
    <Card data-testid="vendors-wanted">
      <CardHeader>
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <Store className="w-5 h-5" aria-hidden />
          Vendors wanted
        </h3>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {showTerms && (
          <p className="text-foreground">
            {call.closesOn && (
              <>
                Applications close <strong>{call.closesOn}</strong>
              </>
            )}
            {call.closesOn && call.fee && " · "}
            {call.fee && (
              <>
                Booth fee <strong>{call.fee}</strong>
                {call.feeNotes && ` (${call.feeNotes})`}
              </>
            )}
          </p>
        )}
        {call.lookingFor.length > 0 && (
          <p className="text-foreground">
            <strong>Looking for:</strong> {call.lookingFor.join(", ")}
          </p>
        )}
        {call.full.length > 0 && (
          <p className="text-foreground">
            <strong>Full:</strong> {call.full.join(", ")}
          </p>
        )}
        {call.applyHref && (
          <OutboundEventLink
            kind="application"
            eventSlug={eventSlug}
            href={call.applyHref}
            className="text-royal hover:underline inline-block"
          >
            Apply on the organizer&apos;s site →
          </OutboundEventLink>
        )}
        {call.asOf && (
          <p className="text-xs italic text-muted-foreground">Vendor call as of {call.asOf}</p>
        )}
      </CardContent>
    </Card>
  );
}
