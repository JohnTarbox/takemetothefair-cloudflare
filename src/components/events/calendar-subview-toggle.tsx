// CAL2 — Month / Agenda / Year sub-view switch for the SSR calendar.
//
// Like ViewToggle, these are plain <Link>s (the `cal_view` param is the source of
// truth) so back/forward + direct links work with no client JS and they're
// crawlable. Shown only when CAL2_VIEWS is on; otherwise the calendar is Month-only
// and no sub-toggle renders. Styling mirrors ViewToggle's segmented control.

import Link from "next/link";
import { CalendarDays, List, CalendarRange, Columns3, Square, LayoutGrid } from "lucide-react";

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
}: {
  view: CalendarSubView;
  searchParams: Record<string, string | undefined>;
}) {
  const hrefFor = (v: CalendarSubView) => {
    const params = new URLSearchParams();
    // Preserve every active filter; reset pagination. `cal`/`cal_year` are kept so
    // returning to a view restores its last anchor.
    for (const [k, val] of Object.entries(searchParams)) {
      if (typeof val === "string" && val && k !== "page" && k !== "view" && k !== "cal_view") {
        params.set(k, val);
      }
    }
    params.set("view", "calendar");
    params.set("cal_view", v);
    return `/events?${params.toString()}`;
  };

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
