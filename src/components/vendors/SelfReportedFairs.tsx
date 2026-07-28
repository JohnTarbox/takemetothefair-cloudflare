import Link from "next/link";
import { Calendar, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { SelfReportedEventItem } from "@/lib/vendors/self-reported-events";

/**
 * OPE-239 — public display of vendor-STATED fair appearances.
 *
 * Labeling approved by John 2026-07-28. The rules this component encodes, and
 * why each one matters:
 *
 *  1. **Its own section, never merged** into "Upcoming Events" or any
 *     organizer-confirmed list. A single blended list would silently upgrade an
 *     unverified assertion into an apparent fact.
 *  2. **The heading itself carries the attribution** — "Fairs this vendor says
 *     they've attended". A reader who skims headings and never reads the small
 *     print still gets the truth, which a footnote alone would not deliver.
 *  3. **A muted disclaimer line** spells out that the organizer has not
 *     confirmed it.
 *  4. **No `rel`-bearing promotional styling** — these are plain internal links
 *     to the event, not endorsements.
 *
 * DISPUTED rows never reach this component (filtered in
 * `listPublicSelfReported`): an assertion an operator has judged false must not
 * be republished, labeled or otherwise.
 */
export function SelfReportedFairs({
  items,
  vendorName,
}: {
  items: SelfReportedEventItem[];
  vendorName: string;
}) {
  // An empty collection renders nothing rather than an empty shell — the
  // OPE-58 crash class starts as an empty-state afterthought.
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="self-reported-fairs-heading">
      <h2 id="self-reported-fairs-heading" className="text-xl font-semibold text-foreground mb-1">
        Fairs this vendor says they&apos;ve attended ({items.length})
      </h2>
      <p className="flex items-start gap-1.5 text-sm text-muted-foreground mb-4">
        <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
        <span>
          Vendor-stated — not confirmed by the organizer.{" "}
          <span className="sr-only">
            The following appearances were reported by {vendorName} and have not been verified
            against the event organizer&apos;s exhibitor list.
          </span>
        </span>
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.eventId}>
            <Card className="border-dashed">
              <CardContent className="p-3 flex items-center gap-3">
                <span
                  className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center text-muted-foreground shrink-0"
                  aria-hidden
                >
                  <Calendar className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <Link
                    href={`/events/${item.eventSlug}`}
                    className="font-medium text-foreground hover:text-navy"
                  >
                    {item.eventName}
                  </Link>
                  <div className="text-sm text-muted-foreground">
                    {[
                      item.startDate ? item.startDate.getUTCFullYear() : null,
                      item.city && item.state ? `${item.city}, ${item.state}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
