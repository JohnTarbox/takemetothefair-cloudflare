/**
 * OPE-1255 — a Search Console "query" that is a row of SOMEONE ELSE's GSC CSV
 * export, typed into Google verbatim:
 *
 *   "craft fairs on cape cod this weekend,410,3051,13.44%,3.16"
 *
 * The tail is clicks, impressions, CTR, position — internally consistent
 * (410/3051 = 13.44%) and unrelated to the row's own metrics. 122 distinct
 * queries, 4,384 rows, 7,072 impressions, 0 clicks (May–Sep 2026), nearly all
 * Cape Cod. Our ingest stores Google's query string verbatim, so these are real
 * GSC rows; they are flagged at READ time, never deleted, because Google's site
 * totals include them and gsc_daily_totals must still tie (OPE-345).
 *
 * Anchored on the full four-field tail. A comma alone is legitimate
 * ("fairs in bangor, me": 1,517 comma rows, 109 clicks).
 */
const EXPORT_ROW_TAIL = /,\d+,\d+,\d+(?:\.\d+)?%,\d+(?:\.\d+)?\s*$/;

export function isGscExportRowQuery(query: string | null | undefined): boolean {
  return typeof query === "string" && EXPORT_ROW_TAIL.test(query);
}
