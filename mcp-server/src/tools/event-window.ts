/**
 * OPE-960 — "what is ON between two instants", for the event selection tools.
 *
 * Before this, every date filter on the MCP surface keyed on `start_date`
 * alone (`search_events.start_after` / `start_before`; `list_all_events` had
 * none). A fair that opened yesterday and closes Sunday fails `start_after =
 * today` — the LOWER bound — so no amount of widening the look-ahead finds it.
 * The nightly performer re-verification wanted exactly one predicate:
 *
 *     end_date >= from  AND  start_date <= to
 *
 * and could not express it, so it paged `search_events` four times and probed
 * ~30 events one at a time to rebuild a two-event set. OPE-959 fixed the same
 * assumption inside `get_performer_data_health`; this is the selection side.
 *
 * Two storage facts shape the predicate:
 *
 * - `start_date` / `end_date` are seconds-epoch integers (`mode: "timestamp"`).
 * - The time of day on a stored date is NOT one convention. Measured on prod
 *   2026-09-13: `litchfield-fair` ends `2026-09-13 23:59:59Z`, `oxford-fair`
 *   ends `2026-09-20 03:59:59Z` (Eastern midnight), and drizzle/0074 wrote
 *   noon UTC. So a date-only `from` is read as the START of that UTC day and a
 *   date-only `to` as its END — every one of those conventions lands inside the
 *   day it means. The cost is a few hours of over-inclusion at the edges
 *   (Oxford still reads as "on" at 00:00Z Sep 20); a sweep can drop an extra
 *   row, and cannot recover a missing one.
 *
 * A single-day event with no `end_date` is on for its start day, hence
 * `COALESCE(end_date, start_date)`. An event with no `start_date` is not in any
 * window — it has no dates to overlap with.
 */
import { sql, type SQL } from "drizzle-orm";
import { events } from "../schema.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a window bound. Date-only strings are widened to the whole UTC day on
 * the side that keeps boundary events (see module doc). Returns null for
 * anything unparseable — the caller must turn that into an ERROR, because a
 * silently-dropped bound returns a confident answer over the wrong set.
 */
export function parseWindowBound(value: string, side: "from" | "to"): Date | null {
  const v = value.trim();
  const iso = DATE_ONLY.test(v) ? `${v}T${side === "from" ? "00:00:00.000" : "23:59:59.999"}Z` : v;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  // `new Date("2026-02-31T00:00:00Z")` rolls over to March 3 rather than
  // failing; a date-only bound must round-trip or it is not the day asked for.
  if (DATE_ONLY.test(v) && d.toISOString().slice(0, 10) !== v) return null;
  return d;
}

const toEpochSeconds = (d: Date) => Math.floor(d.getTime() / 1000);

/** Overlap conditions for `[from, to]`; either side may be omitted. */
export function activeWindowConditions(from: Date | null, to: Date | null): SQL[] {
  const out: SQL[] = [];
  if (from) {
    out.push(sql`COALESCE(${events.endDate}, ${events.startDate}) >= ${toEpochSeconds(from)}`);
  }
  if (to) {
    out.push(sql`${events.startDate} <= ${toEpochSeconds(to)}`);
  }
  return out;
}

export type WindowParseResult =
  | { ok: true; conditions: SQL[]; from: Date | null; to: Date | null }
  | { ok: false; message: string };

/** Validate `active_from` / `active_to` tool params into SQL conditions. */
export function parseActiveWindow(params: {
  active_from?: string;
  active_to?: string;
}): WindowParseResult {
  const from = params.active_from != null ? parseWindowBound(params.active_from, "from") : null;
  if (params.active_from != null && !from) {
    return {
      ok: false,
      message: `active_from is not a date: ${JSON.stringify(params.active_from)}`,
    };
  }
  const to = params.active_to != null ? parseWindowBound(params.active_to, "to") : null;
  if (params.active_to != null && !to) {
    return { ok: false, message: `active_to is not a date: ${JSON.stringify(params.active_to)}` };
  }
  if (from && to && from.getTime() > to.getTime()) {
    return { ok: false, message: "active_from is after active_to — the window is empty" };
  }
  return { ok: true, conditions: activeWindowConditions(from, to), from, to };
}

export const ACTIVE_FROM_DESCRIPTION =
  "OPE-960 overlap window, lower bound: keep events still running at or after this instant (end_date >= active_from; a single-day event with no end_date uses start_date). A fair that opened BEFORE this date and is still on IS returned — which start_after cannot do. YYYY-MM-DD means the start of that UTC day; a full ISO timestamp is used as given.";

export const ACTIVE_TO_DESCRIPTION =
  "OPE-960 overlap window, upper bound: keep events that have started by this instant (start_date <= active_to). With active_from, returns everything ON at any point in [active_from, active_to]. YYYY-MM-DD means the end of that UTC day.";
