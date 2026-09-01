"use client";

/**
 * OPE-738 — client-side filtering over the cross-event entry-deadline index.
 *
 * The full set is server-rendered (small — under a hundred routes) and filtered
 * in the browser, matching /performers and /promoters. Filtering happens BEFORE
 * grouping so the three sections always describe the current filter rather than
 * the whole catalogue.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, MapPin, Search, CircleSlash, HelpCircle } from "lucide-react";
import { formatDateMedium } from "@/lib/datetime";
import {
  filterEntryDeadlines,
  groupEntryDeadlines,
  statesPresent,
  RECENTLY_CLOSED_DAYS,
  type EntryDeadlineRow,
} from "@/lib/applications/list-entry-deadlines";

function DeadlineCard({
  row,
  tone,
}: {
  row: EntryDeadlineRow;
  tone: "open" | "closed" | "undated";
}) {
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium text-foreground">{row.department ?? "General entries"}</p>
        {/* A deadline renders ONLY when one is stored. NULL is never filled in
            from the fair's own dates: there is no rule to infer from, and a
            guessed deadline that makes someone miss an entry is worse than no
            deadline at all. Same doctrine as the per-event section (OPE-709). */}
        {tone === "open" && row.closesAt && (
          <p className="text-sm font-medium text-foreground whitespace-nowrap">
            Closes {formatDateMedium(row.closesAt)}
          </p>
        )}
        {tone === "closed" && row.closesAt && (
          <p className="text-sm text-destructive whitespace-nowrap">
            Closed {formatDateMedium(row.closesAt)}
          </p>
        )}
        {tone === "undated" && (
          <p className="text-sm text-muted-foreground whitespace-nowrap">Date not published</p>
        )}
      </div>

      <p className="mt-1 text-sm text-muted-foreground">
        <Link href={`/events/${row.eventSlug}`} className="text-royal hover:underline">
          {row.eventName}
        </Link>
        {row.venueState && (
          <span className="ml-2 inline-flex items-center gap-1">
            <MapPin className="w-3 h-3" aria-hidden="true" />
            {row.venueCity ? `${row.venueCity}, ${row.venueState}` : row.venueState}
          </span>
        )}
      </p>

      {row.notes && <p className="mt-1 text-xs text-muted-foreground">{row.notes}</p>}

      {row.url && (
        <a
          href={row.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-2 inline-block text-sm text-royal hover:underline"
        >
          Enter or view rules →
        </a>
      )}
      {!row.url && row.contactEmail && (
        <a
          href={`mailto:${row.contactEmail}`}
          className="mt-2 inline-block text-sm text-royal hover:underline break-all"
        >
          {row.contactEmail}
        </a>
      )}
    </li>
  );
}

function Section({
  title,
  hint,
  icon,
  rows,
  tone,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  rows: EntryDeadlineRow[];
  tone: "open" | "closed" | "undated";
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        {icon}
        {title}
        <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <DeadlineCard key={r.id} row={r} tone={tone} />
        ))}
      </ul>
    </section>
  );
}

export function EntryDeadlineBrowser({ rows }: { rows: EntryDeadlineRow[] }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<string | null>(null);

  const states = useMemo(() => statesPresent(rows), [rows]);

  // `now` is computed once per render rather than per row, so a list cannot
  // straddle midnight mid-render and put one row in two groups.
  const grouped = useMemo(
    () => groupEntryDeadlines(filterEntryDeadlines(rows, query, state), new Date()),
    [rows, query, state]
  );

  const total = grouped.open.length + grouped.recentlyClosed.length + grouped.undated.length;

  return (
    <div>
      <div className="mb-6 space-y-4">
        <div className="relative max-w-md">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by department or fair — try “photography”"
            aria-label="Search entry deadlines by department or fair name"
            className="w-full rounded-md border border-border bg-card pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy"
          />
        </div>

        {states.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by state">
            <button
              type="button"
              onClick={() => setState(null)}
              aria-pressed={state === null}
              className={`rounded-full border px-3 py-1 text-sm ${
                state === null
                  ? "border-navy bg-navy text-white"
                  : "border-border bg-card text-foreground hover:border-navy"
              }`}
            >
              All states
            </button>
            {states.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setState(s === state ? null : s)}
                aria-pressed={state === s}
                className={`rounded-full border px-3 py-1 text-sm ${
                  state === s
                    ? "border-navy bg-navy text-white"
                    : "border-border bg-card text-foreground hover:border-navy"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {total === 0 && (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No entry deadlines match that filter. Try clearing the state filter or searching for a
          different department.
        </p>
      )}

      <Section
        title="Open now"
        hint="Sorted by the date entries close — soonest first."
        icon={<CalendarClock className="w-5 h-5 text-amber-500" aria-hidden="true" />}
        rows={grouped.open}
        tone="open"
      />

      <Section
        title="Date not published"
        hint="These fairs publish an entry route but no closing date. Most are still open — check the fair's own page or contact the department."
        icon={<HelpCircle className="w-5 h-5 text-muted-foreground" aria-hidden="true" />}
        rows={grouped.undated}
        tone="undated"
      />

      <Section
        title="Recently closed"
        hint={`Closed within the last ${RECENTLY_CLOSED_DAYS} days — kept here so you can find the department and enter next year.`}
        icon={<CircleSlash className="w-5 h-5 text-destructive" aria-hidden="true" />}
        rows={grouped.recentlyClosed}
        tone="closed"
      />
    </div>
  );
}
