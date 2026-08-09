/**
 * OPE-344 — parse Google's monthly "Search performance" email into an external
 * oracle row.
 *
 * These emails are the only independent check we have on our own GSC ingest.
 * The first hand-comparison (2026-08-04) caught a 65% undercount that had been
 * live for months and that nothing internal could have found, because every
 * internal number came from the same biased source. This makes that check
 * automatic.
 *
 * ── The layout is VALUE-BEFORE-LABEL, and that is the whole difficulty ──────
 * The plaintext body reads:
 *
 *     Your July performance
 *     on Google Search
 *
 *     meetmeatthefair.com
 *
 *     9.37K
 *
 *     Clicks (web)
 *
 *     398K
 *
 *     Impressions (web)
 *
 * A "label then number" regex — the obvious first attempt — matches nothing.
 *
 * Worse, "Clicks (web)" recurs FIVE more times further down as a column header
 * ("Top growing pages", "Top performing pages", "Top performing queries",
 * "Devices"). A global search that takes the nearest preceding number would
 * happily return a per-page click count as the site total. So the headline
 * block is isolated first, and only then searched.
 *
 * ── The year is not in the email ────────────────────────────────────────────
 * Neither subject nor body carries a year — only "July". It has to come from
 * the email's own date, and the naive "use the email's year" breaks once a
 * year: December's report arrives in January. Handled explicitly below.
 *
 * PURE, no I/O, never throws. Returns null for anything that isn't one of these
 * emails, which is how the shared ingest endpoint tells the two shapes apart.
 */
import { parseThresholdToken } from "./gsc-milestone-email";

export interface GscMonthlyOracle {
  /** Reporting month as YYYY-MM. */
  month: string;
  /** Web-search clicks for the month, e.g. "9.37K" → 9370. */
  clicks: number;
  /** Web-search impressions, e.g. "398K" → 398000. */
  impressions: number;
  /** "Pages with first impressions (estimated)", e.g. "2.06K" → 2060. */
  pagesWithFirstImpressions: number | null;
  /**
   * The tokens exactly as Google wrote them. Stored because the parsed values
   * are ROUNDED by Google ("9.37K" is not 9,370 exactly) — keeping the source
   * text means a later reader can tell a parse bug from Google's own rounding.
   */
  raw: { clicks: string; impressions: string; pages: string | null };
  /** The email's own date, YYYY-MM-DD. */
  emailDate: string;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Resolve "July" + an email sent 2026-08-04 to "2026-07".
 *
 * These reports always cover a month that has already ENDED, so the reported
 * month is never after the email's month within the same year. When it appears
 * to be — "December" in a January email — the report belongs to the previous
 * year. Getting this wrong would file every December report under the wrong
 * year, once annually, in a table whose whole purpose is being trustworthy.
 */
export function resolveOracleMonth(monthName: string, emailDate: Date): string | null {
  const idx = MONTH_NAMES.indexOf(monthName.trim().toLowerCase());
  if (idx < 0) return null;
  const monthNum = idx + 1;
  let year = emailDate.getUTCFullYear();
  if (monthNum > emailDate.getUTCMonth() + 1) year -= 1;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
}

/**
 * Isolate the headline metric block: from the "Your <Month> performance"
 * heading to "Your content achievements".
 *
 * The two halves do different jobs, and only one is currently load-bearing —
 * worth saying so rather than implying both are tested:
 *
 *   START slice — LOAD-BEARING. Excludes anything a forward prepends. Without
 *     it, a quoted table above the headline is matched first and a per-page
 *     figure becomes the site total. Pinned by a test.
 *   END trim — defence in depth. `.match()` returns the FIRST occurrence, and
 *     today the headline precedes the five repeated "Clicks (web)" column
 *     headers, so removing this changes nothing. It exists for the layout
 *     change where that stops being true.
 */
function headlineBlock(text: string): string {
  const start = text.search(/Your\s+\w+\s+performance/i);
  const from = start >= 0 ? text.slice(start) : text;
  const end = from.search(/Your content achievements/i);
  return end >= 0 ? from.slice(0, end) : from;
}

/** Value that PRECEDES `label` in the block — the layout these emails use. */
function valueBefore(block: string, label: RegExp): string | null {
  const m = block.match(new RegExp(`([\\d.,]+\\s*[kKmM]?)\\s*\\n\\s*\\n?\\s*${label.source}`, "i"));
  return m ? m[1].trim() : null;
}

export function parseGscMonthlyOracleEmail(input: {
  subject: string | null | undefined;
  body: string | null | undefined;
  emailDate: string | Date;
}): GscMonthlyOracle | null {
  const subject = String(input.subject ?? "");
  const body = String(input.body ?? "");
  if (!subject && !body) return null;

  // Month name from the subject ("Your July Search performance for …") or, for
  // a forward that mangled the subject, from the body heading.
  const monthMatch =
    subject.match(/Your\s+(\w+)\s+Search performance/i) ??
    body.match(/Your\s+(\w+)\s+performance/i);
  if (!monthMatch) return null;

  const emailDate = input.emailDate instanceof Date ? input.emailDate : new Date(input.emailDate);
  if (Number.isNaN(emailDate.getTime())) return null;

  const month = resolveOracleMonth(monthMatch[1], emailDate);
  if (!month) return null;

  const block = headlineBlock(body);
  const clicksRaw = valueBefore(block, /Clicks \(web\)/);
  const imprRaw = valueBefore(block, /Impressions \(web\)/);
  const pagesRaw = valueBefore(block, /Pages with/);

  const clicks = clicksRaw ? parseThresholdToken(clicksRaw) : null;
  const impressions = imprRaw ? parseThresholdToken(imprRaw) : null;
  // Both headline metrics are required. A partial parse would write a row that
  // LOOKS like an oracle reading and would be compared against — a silently
  // wrong baseline is worse than no baseline.
  if (clicks === null || impressions === null) return null;

  const pages = pagesRaw ? parseThresholdToken(pagesRaw) : null;

  return {
    month,
    clicks,
    impressions,
    pagesWithFirstImpressions: pages,
    raw: { clicks: clicksRaw!, impressions: imprRaw!, pages: pagesRaw },
    emailDate: emailDate.toISOString().slice(0, 10),
  };
}

/** Relative divergence between our number and the oracle's, as a fraction. */
export function divergence(ours: number, oracle: number): number {
  if (oracle === 0) return ours === 0 ? 0 : 1;
  return Math.abs(ours - oracle) / oracle;
}

/**
 * Alarm threshold for the API-ingest comparison (10%, per the ticket).
 *
 * Applies ONLY to our property-level figure. The dimensioned store is EXPECTED
 * to diverge — that is OPE-345's whole finding — so its gap is recorded as data
 * and never alarmed on, or this would cry wolf every single month.
 */
export const API_DIVERGENCE_ALARM = 0.1;
