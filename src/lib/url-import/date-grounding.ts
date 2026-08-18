/**
 * OPE-432 — an extracted date must exist in the page it was extracted from.
 *
 * Submitting `marthasvineyardagriculturalsociety.org/the-fair` produced a row
 * dated **2024-08-15 → 2024-08-18**. The page carries an explicit four-year
 * table (2026, 2027, 2028, 2029) and — confirmed by re-fetching — no archive,
 * no past-year content, and the string "2024" nowhere on it. The date range was
 * invented outright.
 *
 * That is the failure mode a language model has and a parser does not, and it
 * is invisible downstream: a fabricated date is perfectly well-formed, passes
 * every schema check, and lands in the catalog looking exactly like a real one.
 * The only place it can be caught is against the source text.
 *
 * ── The check ─────────────────────────────────────────────────────────────
 *
 * The YEAR must appear as a 4-digit token somewhere in the fetched source.
 * Cheap, and it is precisely the dimension that was wrong here.
 *
 * Deliberately NOT the full date string: a page saying "Thursday, August 13th
 * to Sunday, August 16th, 2026" never contains the literal "2026-08-13", so
 * matching the normalized form would reject nearly everything. The year is the
 * part a model invents and the part a page reliably prints.
 *
 * ── Why an absent year is not automatically fatal ─────────────────────────
 *
 * Plenty of legitimate pages print "August 15–18" and leave the year implicit,
 * and inferring the current year there is a reasonable default rather than a
 * fabrication. So the verdict is graded:
 *
 *   grounded    — the year is in the source. Nothing to do.
 *   inferred    — absent, but it is this year or later. Plausible default;
 *                 keep the date and mark it so a caller can lower confidence.
 *   fabricated  — absent AND in the past. A page advertising a fair does not
 *                 mean a year it never mentions and that has already gone by.
 *                 This is the 2024 row, and it is the one we refuse.
 *
 * The asymmetry is the point: a wrongly-kept future date is a visible error an
 * operator can fix from the listing, while a wrongly-rejected date costs one
 * re-submission. A fabricated PAST date is the worst of the three — it is
 * silently filtered out of every forward-looking view, so nobody ever sees it
 * to correct it.
 */

export type DateGroundingVerdict = "grounded" | "inferred" | "fabricated";

export interface DateGroundingResult {
  verdict: DateGroundingVerdict;
  /** The year that was checked, or null when the date was unparseable. */
  year: number | null;
  /** Human-readable reason, for telemetry and operator-facing warnings. */
  reason: string;
}

/**
 * Collect every 4-digit year-shaped token in the source, once.
 *
 * `\d{4}` bounded by non-digits, so "2026" inside "20265" or a phone number
 * like "508.693.9549" does not count as a year.
 */
export function yearsPresentInSource(source: string): Set<number> {
  const found = new Set<number>();
  if (!source) return found;
  for (const m of source.matchAll(/(?<!\d)(\d{4})(?!\d)/g)) {
    const n = Number(m[1]);
    // Anything outside a plausible calendar range is an id, a price, a zip —
    // not a year. 1900–2100 keeps historic "founded in 1858" copy harmless
    // while still covering every date we would ever publish.
    if (n >= 1900 && n <= 2100) found.add(n);
  }
  return found;
}

/**
 * Judge one extracted date against the source it came from.
 *
 * `isoDate` is the sanitized `YYYY-MM-DD` form. `nowYear` is injected rather
 * than read from the clock so the behaviour is testable and so a run near a
 * year boundary is reproducible.
 */
export function groundDateInSource(
  isoDate: string | null | undefined,
  source: string,
  nowYear: number
): DateGroundingResult {
  if (!isoDate) return { verdict: "grounded", year: null, reason: "no date to check" };

  const year = Number(isoDate.slice(0, 4));
  if (!Number.isFinite(year) || year < 1900) {
    return {
      verdict: "grounded",
      year: null,
      reason: "unparseable year; left to schema validation",
    };
  }

  // An empty source proves nothing. Refusing everything when we failed to
  // capture the page would turn a fetch problem into a data-loss problem.
  if (!source || source.trim().length === 0) {
    return { verdict: "grounded", year, reason: "no source text available to check against" };
  }

  if (yearsPresentInSource(source).has(year)) {
    return { verdict: "grounded", year, reason: `${year} appears in the source` };
  }

  if (year < nowYear) {
    return {
      verdict: "fabricated",
      year,
      reason: `${year} appears nowhere in the source and is in the past — the model invented it`,
    };
  }

  return {
    verdict: "inferred",
    year,
    reason: `${year} does not appear in the source; plausible as an implicit current/future year`,
  };
}
