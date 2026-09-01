/**
 * OPE-738 — the cross-event read for `event_applications`.
 *
 * OPE-709 shipped the table and the per-event section. The ruling that chose
 * (c) over (b) did so for one reason, quoted from the issue: "(b) answers
 * *where do I go?*; only (c) answers *am I in time?*" — and answering "am I in
 * time?" means looking ACROSS events, which no event page can do. This module
 * is that query.
 *
 * The bucketing is deliberately split out as pure functions. Two of this
 * ticket's acceptance criteria are about set membership and ordering, and both
 * are the kind of thing that passes on inspection while being wrong: an empty
 * "date not published" group looks identical to "there are no such rows", and
 * an ordering bug only shows up on data where `closes_at` and `start_date`
 * disagree. Pure functions let the tests construct exactly those cases.
 */
import { and, eq, isNull } from "drizzle-orm";
import { eventApplications, events, venues } from "@/lib/db/schema";
import { publicEventWhere } from "@/lib/event-lifecycle";
import type { getCloudflareDb } from "@/lib/cloudflare";

/**
 * How long a CLOSED deadline stays on the page, marked closed.
 *
 * Scope item 5 asked for a decision and a stated reason. Keeping them is the
 * answer, because "you have missed 2026, here is where it opens next year" is
 * a real answer to the question the page exists to serve — and it is literally
 * what support told the customer whose case produced OPE-709. Dropping a
 * deadline the day it passes would make the page silently unhelpful in exactly
 * the week someone is most likely to search for it.
 */
export const RECENTLY_CLOSED_DAYS = 30;

/**
 * Forward horizon. A rolling window anchored on `closes_at` — NOT on the
 * event's own dates.
 *
 * ⚠️ Do not "improve" this by gating on upcoming events. Entry deadlines and
 * fair dates move independently: The Big E's photography entries close in June
 * for a fair that runs in September, and a seasonal market's deadline can sit
 * outside any forward gate drawn on `events.start_date`. Gating on the event
 * is the bug this table was created to make impossible.
 */
export const FORWARD_WINDOW_DAYS = 365;

const DAY_MS = 86_400_000;

export type DeadlineBucket = "open" | "recently_closed" | "undated";

export interface EntryDeadlineRow {
  id: string;
  department: string | null;
  url: string | null;
  contactEmail: string | null;
  notes: string | null;
  closesAt: Date | null;
  eventSlug: string;
  eventName: string;
  eventStartDate: Date | null;
  venueState: string | null;
  venueCity: string | null;
}

export interface GroupedEntryDeadlines {
  open: EntryDeadlineRow[];
  recentlyClosed: EntryDeadlineRow[];
  undated: EntryDeadlineRow[];
}

/**
 * Which group a row belongs in, or `null` when it falls outside the window and
 * should not render at all.
 *
 * A NULL `closes_at` is NEVER outside the window. It is the common case by
 * design — a fair that publishes an entry URL without a date is a legal,
 * correct row — and dropping it would make the index quietly wrong in the one
 * direction that matters, hiding routes that are very likely still open.
 */
export function bucketEntryDeadline(
  closesAt: Date | null,
  now: Date,
  opts: { recentlyClosedDays?: number; forwardWindowDays?: number } = {}
): DeadlineBucket | null {
  if (closesAt === null) return "undated";

  const recentlyClosedDays = opts.recentlyClosedDays ?? RECENTLY_CLOSED_DAYS;
  const forwardWindowDays = opts.forwardWindowDays ?? FORWARD_WINDOW_DAYS;

  const delta = closesAt.getTime() - now.getTime();
  if (delta >= 0) return delta <= forwardWindowDays * DAY_MS ? "open" : null;
  return -delta <= recentlyClosedDays * DAY_MS ? "recently_closed" : null;
}

/**
 * Sort by `closes_at` ascending and split into the three render groups.
 *
 * ⚠️ Sorted on `closes_at`, never on the event's `start_date`. They are not
 * correlated — see FORWARD_WINDOW_DAYS — and sorting by the fair's date would
 * silently reorder the list into something that no longer answers "what closes
 * next", which is the page's whole job.
 *
 * `recently_closed` is sorted DESCENDING: the most recently missed deadline is
 * the one a visitor is most likely to be looking for.
 */
export function groupEntryDeadlines(
  rows: readonly EntryDeadlineRow[],
  now: Date,
  opts: { recentlyClosedDays?: number; forwardWindowDays?: number } = {}
): GroupedEntryDeadlines {
  const grouped: GroupedEntryDeadlines = { open: [], recentlyClosed: [], undated: [] };

  for (const row of rows) {
    switch (bucketEntryDeadline(row.closesAt, now, opts)) {
      case "open":
        grouped.open.push(row);
        break;
      case "recently_closed":
        grouped.recentlyClosed.push(row);
        break;
      case "undated":
        grouped.undated.push(row);
        break;
      default:
        break;
    }
  }

  const at = (r: EntryDeadlineRow) => r.closesAt?.getTime() ?? 0;
  grouped.open.sort((a, b) => at(a) - at(b));
  grouped.recentlyClosed.sort((a, b) => at(b) - at(a));
  // Undated rows have no deadline to sort on, so fall back to the fair's name —
  // a stable, meaningful order rather than whatever the query happened to return.
  grouped.undated.sort((a, b) => a.eventName.localeCompare(b.eventName));

  return grouped;
}

/** Every distinct state present in the set, for the filter control. */
export function statesPresent(rows: readonly EntryDeadlineRow[]): string[] {
  return [...new Set(rows.map((r) => r.venueState).filter((s): s is string => !!s))].sort();
}

/**
 * Filter by state and by a free-text department query.
 *
 * ⚠️ `department` is free text BY DESIGN — "Farm Photography", "Digital
 * Division 4", "Cattle". The OPE-709 ruling chose that deliberately, and this
 * ticket repeats it: do not add a taxonomy or a normalization map here. A
 * substring match on what the fair actually printed is the whole contract; the
 * moment we start mapping "Photography" onto a canonical category we are
 * asserting an equivalence between fairs that no fair agreed to.
 *
 * The query also matches the event name, because "Cumberland" is a perfectly
 * reasonable thing to type into a box on a page listing fairs.
 */
export function filterEntryDeadlines(
  rows: readonly EntryDeadlineRow[],
  query: string,
  state: string | null
): EntryDeadlineRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (state && r.venueState !== state) return false;
    if (!q) return true;
    return (
      (r.department?.toLowerCase().includes(q) ?? false) || r.eventName.toLowerCase().includes(q)
    );
  });
}

/**
 * Every `exhibitor_competition` route on a publicly visible, non-tombstoned
 * event. Window filtering happens in `groupEntryDeadlines`, not here — the
 * query returns the candidate set and the pure layer decides what renders, so
 * the decision is testable without a database.
 */
export async function listEntryDeadlines(
  db: ReturnType<typeof getCloudflareDb>
): Promise<EntryDeadlineRow[]> {
  const rows = await db
    .select({
      id: eventApplications.id,
      department: eventApplications.department,
      url: eventApplications.url,
      contactEmail: eventApplications.contactEmail,
      notes: eventApplications.notes,
      closesAt: eventApplications.closesAt,
      eventSlug: events.slug,
      eventName: events.name,
      eventStartDate: events.startDate,
      venueState: venues.state,
      venueCity: venues.city,
    })
    .from(eventApplications)
    .innerJoin(events, eq(eventApplications.eventId, events.id))
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(
      and(
        eq(eventApplications.lane, "exhibitor_competition"),
        // Tombstones redirect away (OPE-432); listing one hands the visitor a
        // URL that 301s elsewhere.
        isNull(events.mergedInto),
        publicEventWhere()
      )
    );

  return rows as EntryDeadlineRow[];
}
