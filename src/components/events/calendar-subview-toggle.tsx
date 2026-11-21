// CAL2 — Month / Agenda / Year sub-view switch for the SSR calendar.
//
// Like ViewToggle, these are plain <Link>s (the `cal_view` param is the source of
// truth) so back/forward + direct links work with no client JS and they're
// crawlable. Always shown (the CAL2_VIEWS gate was retired in OPE-1394). Styling
// mirrors ViewToggle's segmented control.

import Link from "next/link";
import { CalendarDays, List, CalendarRange, Columns3, Square, LayoutGrid } from "lucide-react";
import { withFocus } from "@/lib/calendar/focus-date";

export type CalendarSubView = "month" | "agenda" | "year" | "week" | "day" | "custom";

const SUB_VIEWS: ReadonlySet<string> = new Set([
  "month",
  "agenda",
  "year",
  "week",
  "day",
  "custom",
]);

/** Parse the `cal_view` param; anything unrecognized → "month". */
export function parseCalSubView(calView: string | undefined): CalendarSubView {
  return calView && SUB_VIEWS.has(calView) ? (calView as CalendarSubView) : "month";
}

const ITEMS: ReadonlyArray<readonly [CalendarSubView, string, typeof CalendarDays]> = [
  ["month", "Month", CalendarDays],
  ["week", "Week", Columns3],
  ["day", "Day", Square],
  ["custom", "Multi-day", LayoutGrid],
  ["agenda", "Agenda", List],
  ["year", "Year", CalendarRange],
];

export function CalendarSubViewToggle({
  view,
  searchParams,
  focusDate,
}: {
  view: CalendarSubView;
  searchParams: Record<string, string | undefined>;
  /** OPE-1488 — the date being viewed; every tab opens on it (Month → its month, Week → its week). */
  focusDate: string;
}) {
  // Preserve every active filter; reset pagination; carry the focus date.
  const hrefFor = (v: CalendarSubView) =>
    `/events?${withFocus(searchParams, focusDate, v).toString()}`;

  return (
    <div
      className="inline-flex rounded-lg border border-border p-1 bg-card"
      role="tablist"
      aria-label="Calendar view"
    >
      {ITEMS.map(([v, label, Icon]) => (
        <Link
          key={v}
          href={hrefFor(v)}
          role="tab"
          aria-selected={view === v}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            view === v
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          <Icon className="w-4 h-4" />
          {label}
        </Link>
      ))}
    </div>
  );
}
