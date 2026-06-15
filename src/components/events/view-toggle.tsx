// CAL1 — server-rendered Cards/Table/Calendar toggle.
//
// The legacy toggle lives inside the client EventsView; when the SSR Month branch
// replaces EventsView, we still need a way back to list views. These are plain
// <Link>s (the `view` param is the source of truth), so back/forward and direct
// links work with no client JS — and they're crawlable. Styling mirrors the
// segmented control in events-view.tsx.

import Link from "next/link";
import { LayoutGrid, Table, Calendar as CalendarIcon } from "lucide-react";

type View = "cards" | "table" | "calendar";

const ITEMS: ReadonlyArray<readonly [View, string, typeof LayoutGrid]> = [
  ["cards", "Cards", LayoutGrid],
  ["table", "Table", Table],
  ["calendar", "Calendar", CalendarIcon],
];

export function ViewToggle({
  view,
  searchParams,
}: {
  view: View;
  searchParams: Record<string, string | undefined>;
}) {
  const hrefFor = (v: View) => {
    const params = new URLSearchParams();
    for (const [k, val] of Object.entries(searchParams)) {
      if (typeof val === "string" && val && k !== "page" && k !== "view") params.set(k, val);
    }
    params.set("view", v);
    return `/events?${params.toString()}`;
  };

  return (
    <div className="inline-flex rounded-lg border border-border p-1 bg-card">
      {ITEMS.map(([v, label, Icon]) => (
        <Link
          key={v}
          href={hrefFor(v)}
          aria-current={view === v ? "page" : undefined}
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
