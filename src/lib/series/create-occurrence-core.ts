/**
 * EH3 P3.1 — pure core for create_occurrence.
 *
 * Builds the inheritable `events` insert values for a new occurrence under a
 * series: override-or-inherit per field, with the fixed skeleton posture John
 * locked (TENTATIVE, dates_confirmed=false, flagged_for_review, NO RRULE date
 * compute — dates come from explicit overrides or stay null for an operator to
 * fill in). The MCP tool adds id/slug/timestamps/source fields and does the
 * insert + idempotency query + audit. Pure + unit-tested like the rest of
 * src/lib/series/.
 */
export type PrimaryAudience = "PUBLIC" | "TRADE" | "MEMBERS";
export type PublicAccess = "OPEN" | "CLOSED";

export interface SeriesRow {
  id: string;
  name: string;
  venueId: string | null;
  promoterId: string | null;
  recurrenceRule: string | null;
  description: string | null;
  imageUrl: string | null;
  categories: string | null;
  tags: string | null;
  primaryAudience: PrimaryAudience;
  publicAccess: PublicAccess;
}

export interface OccurrenceOverrides {
  name?: string;
  venueId?: string | null;
  promoterId?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  description?: string | null;
  imageUrl?: string | null;
  /**
   * OPE-581 — caller-supplied taxonomy. Absent (undefined) still inherits the
   * series values, which is the right default for a rollover; present wins,
   * because a discovery run that classified the event knows more about THIS
   * edition than the series row does.
   *
   * Inheriting unconditionally is what made the series route manufacture the
   * exact condition the admin uncategorized queue exists to catch: a series
   * with empty `categories` stamped `[]` onto every occurrence under it, while
   * the caller's four categories were dropped on the floor.
   */
  categories?: string | null;
  tags?: string | null;
}

export interface OccurrenceInsertValues {
  seriesId: string;
  name: string;
  venueId: string | null;
  promoterId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  recurrenceRule: string | null;
  description: string | null;
  imageUrl: string | null;
  categories: string | null;
  tags: string | null;
  primaryAudience: PrimaryAudience;
  publicAccess: PublicAccess;
  status: "TENTATIVE";
  lifecycleStatus: "TENTATIVE";
  datesConfirmed: false;
  flaggedForReview: true;
  rolledFromEventId: string | null;
}

// An override key present (even as null) wins over the series default; absent
// (undefined) inherits. Lets a caller explicitly null out a venue/promoter.
function pick<T>(override: T | undefined, fallback: T): T {
  return override !== undefined ? override : fallback;
}

export function inheritSeriesDefaults(
  series: SeriesRow,
  overrides: OccurrenceOverrides = {},
  opts: { rolledFromEventId?: string | null } = {}
): OccurrenceInsertValues {
  return {
    seriesId: series.id,
    name: overrides.name ?? series.name,
    venueId: pick(overrides.venueId, series.venueId),
    promoterId: pick(overrides.promoterId, series.promoterId),
    startDate: pick(overrides.startDate, null), // skeleton: null unless given
    endDate: pick(overrides.endDate, null),
    recurrenceRule: series.recurrenceRule,
    description: pick(overrides.description, series.description),
    imageUrl: pick(overrides.imageUrl, series.imageUrl),
    categories: pick(overrides.categories, series.categories),
    tags: pick(overrides.tags, series.tags),
    primaryAudience: series.primaryAudience,
    publicAccess: series.publicAccess,
    status: "TENTATIVE",
    lifecycleStatus: "TENTATIVE",
    datesConfirmed: false,
    flaggedForReview: true,
    rolledFromEventId: opts.rolledFromEventId ?? null,
  };
}

/**
 * UTC year bounds for the idempotency query: an occurrence for `year` exists iff
 * a series sibling has `gte <= start_date < lt`. (Half-open, so Dec 31 23:59 of
 * `year` is in, Jan 1 of `year+1` is out.)
 */
export function occurrenceYearBounds(year: number): { gte: Date; lt: Date } {
  return {
    gte: new Date(Date.UTC(year, 0, 1)),
    lt: new Date(Date.UTC(year + 1, 0, 1)),
  };
}
