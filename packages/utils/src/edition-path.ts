/**
 * OPE-1324 (multi-edition series, step 1/5) — the ONE place that turns a series
 * occurrence into a URL, and a URL segment back into an occurrence.
 *
 * The rule `/events/<series canonical_slug>/<UTC year of start_date>` used to be
 * written out by hand in ~11 builders and 5 parsers across the main app and the
 * MCP server (OPE-1315 round-2 inventory). Multi-edition series (OPE-1315 option
 * A) will widen the segment from a year to an edition key; with the rule copied
 * that many times, one missed copy would silently send the second edition's
 * links, canonical or redirect to the first, and nothing would error.
 *
 * So every builder and parser now goes through here, and
 * `scripts/check-occurrence-paths.ts` (CI) fails on a hand-built
 * `/events/${…}/${…}` anywhere else.
 *
 * In this step every series is annual: the output is byte-for-byte what the
 * hand-written copies produced (pinned by the golden test).
 *
 * Lives in packages/utils because the MCP Worker cannot import `src/`.
 */

/** The occurrence segment of an annual series: a canonical 4-digit year. */
export const OCCURRENCE_YEAR_SEGMENT_RE = /^\d{4}$/;

/** UTC year of an occurrence's start — the year every occurrence URL carries. */
export function occurrenceYear(
  startDate: Date | number | string | null | undefined
): number | null {
  if (startDate === null || startDate === undefined) return null;
  const y = new Date(startDate).getUTCFullYear();
  return Number.isFinite(y) ? y : null;
}

/** `/events/<seriesSlug>/<year>` — the single template. */
export function seriesOccurrencePath(seriesSlug: string, year: number | string): string {
  return `/events/${seriesSlug}/${year}`;
}

/** The occurrence path for a dated member of a series, or null when undated. */
export function occurrencePath(
  seriesSlug: string,
  startDate: Date | number | string | null | undefined
): string | null {
  const year = occurrenceYear(startDate);
  return year === null ? null : seriesOccurrencePath(seriesSlug, year);
}

/**
 * Canonical path for ANY event row: a dated series member resolves to its
 * occurrence URL; anything else keeps `/events/<slug>`.
 */
export function eventCanonicalPath(row: {
  slug: string;
  seriesSlug?: string | null;
  startDate?: Date | number | string | null;
}): string {
  if (row.seriesSlug) {
    const p = occurrencePath(row.seriesSlug, row.startDate);
    if (p) return p;
  }
  return `/events/${row.slug}`;
}

/**
 * Parse the segment after the series slug. Annual: exactly a canonical integer
 * year ("2026"; never "02026", "2026.0" or "26"). Null for anything else, so
 * `/events/<slug>/vendors` and `/events/<state>/<facet>` never match.
 */
export function parseOccurrenceSegment(segment: string): { year: number } | null {
  if (!OCCURRENCE_YEAR_SEGMENT_RE.test(segment)) return null;
  const year = Number.parseInt(segment, 10);
  return String(year) === segment ? { year } : null;
}

/**
 * The occurrence a segment names, chosen DETERMINISTICALLY: earliest start, then
 * lowest id. Rows used to be taken in whatever order the query returned them,
 * so two same-year members could resolve differently on the page and in the
 * ETag lookup. (Prod has 0 such public pairs today; this keeps it that way.)
 */
export function pickOccurrenceForYear<T extends { startDate: Date | null; id?: string | null }>(
  occurrences: readonly T[],
  year: number
): T | undefined {
  const time = (d: Date | null) => (d ? new Date(d).getTime() : Number.POSITIVE_INFINITY);
  return [...occurrences]
    .filter((o) => o.startDate && occurrenceYear(o.startDate) === year)
    .sort(
      (a, b) => time(a.startDate) - time(b.startDate) || (a.id ?? "").localeCompare(b.id ?? "")
    )[0];
}
