import { Mail, Phone, Store } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { OutboundEventLink } from "@/components/OutboundEventLink";
import { formatDateMedium } from "@/lib/datetime";
import { telHref, type VendorCta } from "@/lib/events/vendor-cta";

type OrganizerCta = Extract<VendorCta, { kind: "organizer_apply" | "organizer_contact" }>;

interface Props {
  cta: OrganizerCta;
  eventName: string;
  eventSlug: string;
}

/**
 * OPE-986 A2 (copy approved verbatim by John, 2026-10-17) — the event-page card
 * that replaced "Are you a vendor? / Login to Apply" wherever an in-app
 * application would reach nobody. It says where applications actually go:
 * the organizer's own link, or the organizer contact we hold.
 *
 * `id="vendor-apply"` is the mobile StickyApplyBar's scroll target.
 */
export function VendorOrganizerCard({ cta, eventName, eventSlug }: Props) {
  return (
    <Card id="vendor-apply">
      <CardHeader>
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <Store className="w-5 h-5" aria-hidden />
          Selling at this fair?
        </h3>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {cta.kind === "organizer_apply" ? (
          <>
            <p className="text-muted-foreground">
              Applications go to the organizer, not through Meet Me at the Fair.
            </p>
            {cta.deadline && (
              <p
                className={`font-medium ${cta.deadline < new Date() ? "text-destructive" : "text-foreground"}`}
              >
                Deadline: {formatDateMedium(cta.deadline)}
                {cta.deadline < new Date() && " (Passed)"}
              </p>
            )}
            <OutboundEventLink
              kind="application"
              eventSlug={eventSlug}
              href={cta.href}
              className="text-royal hover:underline inline-block"
            >
              Apply on the organizer&apos;s site →
            </OutboundEventLink>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              We don&apos;t have vendor application details for {eventName}. Applications go to the
              organizer, not through Meet Me at the Fair
              {cta.organizerName === null
                ? "."
                : cta.websiteHref
                  ? ` — check ${cta.organizerName}'s website.`
                  : ` — contact ${cta.organizerName}.`}
            </p>
            {(cta.contactEmail || cta.contactPhone) && (
              <ul className="space-y-1">
                {cta.contactEmail && (
                  <li className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-muted-foreground" aria-hidden />
                    <a
                      href={`mailto:${cta.contactEmail}`}
                      className="text-royal hover:underline break-all"
                    >
                      {cta.contactEmail}
                    </a>
                  </li>
                )}
                {cta.contactPhone && (
                  <li className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-muted-foreground" aria-hidden />
                    <a href={telHref(cta.contactPhone)} className="text-royal hover:underline">
                      {cta.contactPhone}
                    </a>
                  </li>
                )}
              </ul>
            )}
            {cta.websiteHref && (
              <a
                href={cta.websiteHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-royal hover:underline inline-block"
              >
                Visit organizer website →
              </a>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
