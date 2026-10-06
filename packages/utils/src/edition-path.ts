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
 * OPE-1326 (step 3/5) — a series whose `edition_mode` is 'multi' addresses each
 * member by its stored `events.edition_key` ("2027-05", "2027-05-xli") instead
 * of its year. Every function below takes the mode/key as OPTIONAL input and
 * returns exactly the step-1 output when they are absent or the mode is
 * 'annual', so an unconverted caller can only ever produce today's URL (pinned
 * by the OPE-1324 golden test).
 *
 * Lives in packages/utils because the MCP Worker cannot import `src/`.
 */
import { getVenueZoneYearMonth } from "@takemetothefair/datetime";

/** The occurrence segment of an annual series: a canonical 4-digit year. */
export const OCCURRENCE_YEAR_SEGMENT_RE = /^\d{4}$/;

/**
 * OPE-1326 — an edition key: `YYYY-MM` of the start date (venue time zone),
 * optionally followed by an operator-chosen suffix for a same-month clash
 * (`2027-05-xli`). Lowercase alphanumerics in dash-separated words only, so a
 * key can never be mistaken for a year, a facet route, or `vendors`.
 */
export const EDITION_KEY_SEGMENT_RE = /^(\d{4})-(0[1-9]|1[0-2])(?:-[a-z0-9]+)*$/;

/** `event_series.edition_mode`. Anything other than 'multi' reads as annual. */
export type EditionMode = "annual" | "multi";

/** The optional edition inputs every builder accepts. */
export interface EditionInput {
  editionMode?: string | null;
  editionKey?: string | null;
}

/** Is this a well-formed edition key? */
export function isEditionKey(value: string | null | undefined): value is string {
  return typeof value === "string" && EDITION_KEY_SEGMENT_RE.test(value);
}

/**
 * OPE-1327 — derive an edition key: `YYYY-MM` of the start in the venue zone,
 * plus an optional operator suffix for a same-month clash (`2027-05-xli`).
 * Null when undated, or when the suffix would not round-trip through the
 * parser (uppercase, spaces, punctuation) — a key that cannot be a URL segment
 * must never be stored.
 */
export function deriveEditionKey(
  startDate: Date | number | string | null | undefined,
  suffix?: string | null
): string | null {
  const ym = getVenueZoneYearMonth(startDate);
  if (!ym) return null;
  const base = `${ym.y}-${String(ym.m).padStart(2, "0")}`;
  const key = suffix ? `${base}-${suffix}` : base;
  return isEditionKey(key) ? key : null;
}

/** The key a member is addressed by, or null when it is addressed by its year. */
export function editionKeyFor(edition: EditionInput | null | undefined): string | null {
  return edition?.editionMode === "multi" && isEditionKey(edition.editionKey)
    ? edition.editionKey
    : null;
}

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

/**
 * The occurrence path for a dated member of a series, or null when undated.
 * On a multi-edition series a member with a valid stored key is addressed by
 * that key; every other member (and every annual series) by its UTC year.
 */
export function occurrencePath(
  seriesSlug: string,
  startDate: Date | number | string | null | undefined,
  edition?: EditionInput | null
): string | null {
  const key = editionKeyFor(edition);
  if (key) return seriesOccurrencePath(seriesSlug, key);
  const year = occurrenceYear(startDate);
  return year === null ? null : seriesOccurrencePath(seriesSlug, year);
}

/**
 * Canonical path for ANY event row: a dated series member resolves to its
 * occurrence URL; anything else keeps `/events/<slug>`.
 */
export function eventCanonicalPath(
  row: {
    slug: string;
    seriesSlug?: string | null;
    startDate?: Date | number | string | null;
  } & EditionInput
): string {
  if (row.seriesSlug) {
    const p = occurrencePath(row.seriesSlug, row.startDate, row);
    if (p) return p;
  }
  return `/events/${row.slug}`;
}

/**
 * The segment after the series slug, parsed. A YEAR (`{ kind: "year", year }`)
 * is exactly a canonical integer year ("2026"; never "02026", "2026.0" or "26")
 * and is tested FIRST, so every annual URL parses exactly as it did in step 1.
 * An EDITION (`{ kind: "edition", key }`) matches EDITION_KEY_SEGMENT_RE.
 *
 * The edition variant deliberately has NO `year` field: a caller written for
 * years that reads `.year` off an edition segment is a compile error, not a
 * silent wrong-edition lookup.
 *
 * Null for anything else, so `/events/<slug>/vendors` and
 * `/events/<state>/<facet>` never match.
 */
export type OccurrenceSegment = { kind: "year"; year: number } | { kind: "edition"; key: string };

export function parseOccurrenceSegment(segment: string): OccurrenceSegment | null {
  if (OCCURRENCE_YEAR_SEGMENT_RE.test(segment)) {
    const year = Number.parseInt(segment, 10);
    return String(year) === segment ? { kind: "year", year } : null;
  }
  if (isEditionKey(segment)) return { kind: "edition", key: segment };
  return null;
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

/**
 * OPE-1326 — what a request for `/events/<series>/<segment>` should do, decided
 * in ONE place for the page resolver, the middleware 301s, the ETag lookup and
 * the MCP own-event-url resolver.
 *
 *   segment  mode     →
 *   year     annual   render that year's member (step-1 behaviour, unchanged)
 *   year     multi    301 to that year's member's edition path — the earliest
 *                     member of the year, deterministically. A member with no
 *                     valid key renders at the year, as its builder addresses it.
 *   edition  multi    render the member holding that key
 *   edition  annual   301 to that member's YEAR path. This is the rollback path
 *                     (flip a series back to annual and every indexed edition
 *                     URL lands on its year), kept permanently.
 *
 * `path` on a redirect is always the target's own `occurrencePath`, so the 301
 * lands on the canonical URL in one hop. Null = no such member (the page 404s).
 */
export type OccurrenceResolution<T> =
  | { action: "render"; occurrence: T }
  | { action: "redirect"; occurrence: T; path: string };

export function resolveOccurrence<
  T extends { startDate: Date | null; id?: string | null; editionKey?: string | null },
>(
  seriesSlug: string,
  editionMode: string | null | undefined,
  occurrences: readonly T[],
  segment: OccurrenceSegment
): OccurrenceResolution<T> | null {
  const multi = editionMode === "multi";
  if (segment.kind === "year") {
    const hit = pickOccurrenceForYear(occurrences, segment.year);
    if (!hit) return null;
    if (!multi) return { action: "render", occurrence: hit };
    const path = occurrencePath(seriesSlug, hit.startDate, {
      editionMode,
      editionKey: hit.editionKey,
    });
    const self = seriesOccurrencePath(seriesSlug, segment.year);
    return path && path !== self
      ? { action: "redirect", occurrence: hit, path }
      : { action: "render", occurrence: hit };
  }
  const hit = occurrences.find((o) => o.editionKey === segment.key);
  if (!hit) return null;
  if (multi) return { action: "render", occurrence: hit };
  const path = occurrencePath(seriesSlug, hit.startDate);
  return path ? { action: "redirect", occurrence: hit, path } : null;
}

/**
 * OPE-1327 — where may an incoming edition go on a MULTI-EDITION series?
 * `create` with its derived key only when that key is free AND no live member
 * starts within ±7 days; otherwise `stage`, naming the member it collided with
 * (the same edition resubmitted, or a dates-changed resubmission — a human
 * decides). Pure: each workspace runs its own member query (live members only:
 * not REJECTED, not merged) and calls this, so the app's submit route and the
 * MCP suggest_event agree by construction.
 */
export const EDITION_NEAR_WINDOW_MS = 7 * 24 * 3600 * 1000;

export type EditionPlacement =
  | { kind: "create"; editionKey: string }
  | { kind: "stage"; editionKey: string | null; nearEditionId: string | null };

export function decideEditionPlacement(
  members: readonly { id: string; startDate: Date | null; editionKey: string | null }[],
  incomingStart: Date
): EditionPlacement {
  const editionKey = deriveEditionKey(incomingStart);
  const keyHolder = editionKey ? members.find((m) => m.editionKey === editionKey) : undefined;
  const near = members.find(
    (m) =>
      m.startDate &&
      Math.abs(new Date(m.startDate).getTime() - incomingStart.getTime()) <= EDITION_NEAR_WINDOW_MS
  );
  if (!editionKey || keyHolder || near) {
    return { kind: "stage", editionKey, nearEditionId: (near ?? keyHolder)?.id ?? null };
  }
  return { kind: "create", editionKey };
}
