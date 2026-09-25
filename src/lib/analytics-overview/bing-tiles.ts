/**
 * OPE-1131 — the Bing tab's headline figures as `Measurement`s.
 *
 * `loadBingData` turned every failed Bing report into `[]`, and the tab then
 * rendered the empty array as a READING. On a fetch failure the page said:
 *
 *   - "Crawl issues: 0 issues — healthy ✓"
 *   - "Crawl errors (7d): 0", in green
 *   - "Search clicks (7d): 0" / "Impressions (7d): 0"
 *   - "IndexNow health: Active · 0 sent · 0 failed" — with KV or D1 down
 *
 * Health was shown in place of "unknown". These helpers take the failure bit
 * the loader now records, and say which it is.
 *
 * The "7d" figures are also the last 7 ROWS, whatever their dates, so a feed
 * that stopped kept showing its final week. They are judged for staleness on
 * the newest row's date.
 */
import { freshness, ok, unavailable, type Measurement } from "./render-state";

export type BingReport = "queries" | "pages" | "crawl" | "scan" | "traffic" | "sitemaps";

interface Dated {
  date: string;
}

function newestDate(rows: Dated[]): number | null {
  let max: number | null = null;
  for (const r of rows) {
    const t = Date.parse(r.date);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/** Sum of the newest 7 rows' `field`, judged stale on the newest row's date. */
export function bingWeekTotal<R extends Dated>(
  rows: R[],
  field: (r: R) => number,
  failed: boolean,
  feed: string,
  now: Date = new Date()
): Measurement<number> {
  if (failed) return unavailable("Bing report unavailable");
  if (rows.length === 0) return unavailable("no Bing rows yet");
  const newest7 = [...rows].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  const total = newest7.reduce((a, r) => a + field(r), 0);
  return freshness(total, feed, newestDate(rows), now);
}

/** Latest crawl's page count. */
export function bingPagesIndexed(
  crawl: Array<Dated & { totalPages: number }>,
  failed: boolean,
  now: Date = new Date()
): Measurement<number> {
  if (failed) return unavailable("Bing crawl report unavailable");
  if (crawl.length === 0) return unavailable("no crawl data yet");
  const latest = [...crawl].sort((a, b) => b.date.localeCompare(a.date))[0];
  return freshness(latest.totalPages, "bing_crawl", newestDate(crawl), now);
}

/** Error + warning issues from the site scan. */
export function bingScanIssueCount(
  scan: Array<{ severity: string }>,
  failed: boolean
): Measurement<number> {
  if (failed) return unavailable("Bing site-scan report unavailable");
  return ok(scan.filter((i) => i.severity === "Error" || i.severity === "Warning").length);
}

/** An IndexNow count from D1 — only a number if the read happened. */
export function indexNowCount(value: number, countsAvailable: boolean): Measurement<number> {
  return countsAvailable ? ok(value) : unavailable("indexnow_submissions read failed");
}

/**
 * The health chip. "Active" is a claim about the breaker state in KV; with no
 * KV it cannot be made, so it says so rather than defaulting to green.
 */
export function indexNowChip(ops: {
  kvAvailable: boolean;
  paused: boolean;
  breaker: { reason: string | null };
}): { label: string; className: string } {
  if (!ops.kvAvailable) return { label: "Unknown", className: "text-muted-foreground" };
  if (ops.paused) return { label: "Paused", className: "text-amber-600" };
  if (ops.breaker.reason === "cooldown") return { label: "Cooldown", className: "text-amber-600" };
  return { label: "Active", className: "text-emerald-600" };
}

/**
 * OPE-1161 E14 — which inputs to the Bing "Action items" card were NOT measured.
 *
 * A report that fails to load becomes `[]`, so its rule cannot fire and the
 * card printed "No action items — healthy ✓" for a tab it had not read. The
 * empty list is only a clean bill of health when every input was measured;
 * otherwise the card names what it could not see.
 */
export function bingActionInputsUnmeasured(
  failed: readonly BingReport[],
  ops: { kvAvailable: boolean; countsAvailable: boolean }
): string[] {
  const out: string[] = [];
  if (failed.includes("crawl")) out.push("crawl report (crawl errors, coverage)");
  if (failed.includes("scan")) out.push("crawl-issue report");
  if (failed.includes("sitemaps")) out.push("sitemap feeds (duplicates, coverage)");
  if (!ops.kvAvailable) out.push("IndexNow pause/cooldown state");
  if (!ops.countsAvailable) out.push("IndexNow failure counts");
  return out;
}
