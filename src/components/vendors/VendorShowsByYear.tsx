/**
 * EH3 P2.5b — "Shows by year": the recurring series a vendor returns to, each
 * with its years linking to the per-year occurrence pages. Rendered only when a
 * vendor has at least one 2+-year series (the caller filters), so it's a
 * highlight, not a restatement of the chronological event lists.
 */
import Link from "next/link";
import { Calendar } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { VendorShowSeries } from "@/lib/series/group-vendor-shows";

export function VendorShowsByYear({ series }: { series: VendorShowSeries[] }) {
  if (series.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-secondary">
          <Calendar className="h-5 w-5 text-terracotta" />
          Shows by year
        </h2>
        <p className="text-sm text-secondary/70">Recurring events this vendor returns to.</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {series.map((s) => (
            <li
              key={s.seriesSlug}
              className="border-b border-secondary/10 pb-4 last:border-0 last:pb-0"
            >
              <Link
                href={`/events/${s.seriesSlug}`}
                className="font-display font-semibold text-secondary hover:text-terracotta"
              >
                {s.seriesName}
              </Link>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {s.years.map((y) => (
                  <Link
                    key={`${s.seriesSlug}-${y.year ?? y.eventSlug}`}
                    href={y.year ? `/events/${s.seriesSlug}/${y.year}` : `/events/${y.eventSlug}`}
                    className="rounded border border-secondary/20 px-2 py-0.5 text-sm font-medium text-secondary hover:border-terracotta hover:text-terracotta"
                  >
                    {y.year ?? "—"}
                  </Link>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
