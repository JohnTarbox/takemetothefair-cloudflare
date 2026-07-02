/**
 * OPE-49 — split site-health rows into "action needed" vs "expected
 * non-indexing".
 *
 * GSC surfaces a family of coverage verdicts that are perfectly normal for
 * thin / seasonal / duplicate pages (a seasonal farmers-market page that only
 * goes live for six weeks a year will legitimately sit in "Discovered –
 * currently not indexed" the rest of the year). Those are NOT defects, and
 * dumping them in the same red pile as a 5xx or a broken JSON-LD field trains
 * the operator to ignore the whole panel. This pure classifier lets the tab
 * (and any future alerting) tier them apart.
 *
 * Anything that is a genuine defect — 5xx/fetch errors, "Submitted URL…"
 * states, robots-blocked, redirect errors, ANY GSC_RICH_RESULT_FAIL (broken
 * structured data), ANY Bing/sitemap error — is deliberately NOT matched here
 * and therefore falls through to the ACTION tier.
 */

/**
 * Coverage-state fragments that mark a row as expected (non-defect). Stored in
 * lower-case with ASCII hyphens; the input message is lower-cased and has its
 * unicode dashes (en-dash "–", em-dash "—", etc.) folded to "-" before
 * matching, so both `Discovered - currently not indexed` and
 * `Discovered – currently not indexed` hit the same fragment.
 */
const EXPECTED_MESSAGE_FRAGMENTS = [
  "discovered - currently not indexed",
  "crawled - currently not indexed",
  "url is unknown to google",
  "alternate page with proper canonical",
  "duplicate without user-selected canonical",
  "page with redirect",
];

/** Fold the various unicode dash code points (U+2010–U+2015) to an ASCII "-". */
function normalizeDashes(s: string): string {
  return s.replace(/[‐-―]/g, "-");
}

/**
 * True when a health row represents an expected, non-actionable GSC coverage
 * state rather than a real defect. Rich-result failures are never expected;
 * an empty/null message is never expected.
 */
export function isExpectedNonIndexing(issueType: string, message: string | null): boolean {
  // Broken structured data is always a real defect, regardless of any coverage
  // text that might accompany it.
  if (issueType === "GSC_RICH_RESULT_FAIL") return false;
  if (!message) return false;
  const normalized = normalizeDashes(message.toLowerCase());
  return EXPECTED_MESSAGE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Display tier for a single issue row. */
export function deriveDisplayTier(issue: {
  issueType: string;
  message: string | null;
}): "ACTION" | "EXPECTED" {
  return isExpectedNonIndexing(issue.issueType, issue.message) ? "EXPECTED" : "ACTION";
}
