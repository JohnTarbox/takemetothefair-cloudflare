import type { TileDefinition } from "./types";

/**
 * OPE-1159 — Bing tab (BingTab / loadBingData / loadIndexNowOps in
 * src/app/admin/analytics/page.tsx, helpers in ../bing-tiles.ts, API client in
 * src/lib/bing-webmaster.ts). Written from the code, not the card labels.
 */
export const BING_TILES = {
  "bing.search-clicks": {
    measures:
      "Bing search clicks summed over the newest 7 daily rows, with a change badge against the 7 rows before and a sparkline of the last 30.",
    source: "Bing Webmaster API GetRankAndTrafficStats.",
    window:
      "Newest 7 rows Bing returns, not 7 calendar days. Cached 15 minutes in KV. Stale if the newest row is over 5 days old.",
    caveats: "If Bing skips days, the 7 rows cover more than a week. Bing data lags a few days.",
  },
  "bing.impressions": {
    measures:
      "Bing search impressions summed over the newest 7 daily rows, with a change badge against the 7 rows before and a sparkline of the last 30.",
    source: "Bing Webmaster API GetRankAndTrafficStats.",
    window:
      "Newest 7 rows Bing returns, not 7 calendar days. Cached 15 minutes in KV. Stale if the newest row is over 5 days old.",
    caveats: "If Bing skips days, the 7 rows cover more than a week. Bing data lags a few days.",
  },
  "bing.pages-indexed": {
    measures:
      "Bing's count of the site's pages in its index, taken from the most recent crawl-stats row.",
    source: "Bing Webmaster API GetCrawlStats (InIndex, formerly TotalPagesInIndex).",
    window:
      "A single point-in-time figure from the latest crawl day. Cached 15 minutes in KV. Marked stale if that day is over 5 days old.",
    caveats:
      "Bing's own total, not checked against our sitemap. It can include URLs we no longer list.",
  },
  "bing.crawl-errors": {
    measures: "Crawl errors Bing reported, summed over the newest 7 crawl-report rows.",
    source: "Bing Webmaster API GetCrawlStats (CrawlErrors, else 4xx + 5xx + connection timeouts).",
    window:
      "7 crawl-report days, whatever their dates, not the last 7 calendar days. Cached 15 minutes in KV. Marked stale if over 5 days old.",
    caveats: "Shows Unavailable rather than a green 0 when the crawl report fails.",
    thresholds: "Green at a measured 0; amber above 0. Any errors also add an Action item.",
  },
  "bing.indexnow-health": {
    measures:
      "Whether IndexNow pings can go out right now (Active, Paused, Cooldown or Unknown), plus the last 24 hours of submissions: sent, failed and skipped.",
    source: "RATE_LIMIT_KV breaker keys (indexnow:paused, cooldown); D1 indexnow_submissions.",
    window: "State is read live. Counts cover the last 24 hours.",
    caveats:
      "While the indexnow:paused KV flag is set, nothing is sent: 0 failed means nothing was tried, and blocked pings count as skipped. Counts are submission batches, not URLs. If reading KV throws, it shows Active.",
    thresholds:
      "Green when Active; amber when Paused or in Cooldown; grey when there is no KV binding.",
  },
  "bing.top-queries": {
    measures:
      "Up to 25 Bing search queries with the most clicks, showing each one's impressions, CTR and average impression position.",
    source: "Bing Webmaster API GetQueryStats.",
    window:
      "Whatever period Bing's report covers. We send no date range and do not filter by date. Cached 15 minutes in KV.",
    caveats:
      "Not a fixed 7 or 28 days, so it can't be compared directly with the Google tab. Rows are shown as Bing returns them and are not merged per query. A position of -1 shows as a dash.",
  },
  "bing.top-pages": {
    measures:
      "Up to 15 pages with the most Bing clicks, showing each one's impressions, CTR and average impression position.",
    source: "Bing Webmaster API GetPageStats (the page URL comes in the Query field).",
    window:
      "Whatever period Bing's report covers. We send no date range and do not filter by date. Cached 15 minutes in KV.",
    caveats:
      "Not a fixed 7 or 28 days, so it can't be compared directly with the Google tab. Rows are shown as Bing returns them and are not merged per URL.",
  },
  "bing.crawl-trend": {
    measures:
      "For each crawl day, newest first: pages Bingbot crawled, crawl errors, and pages in Bing's index.",
    source: "Bing Webmaster API GetCrawlStats.",
    window: "The 30 most recent crawl-report rows. Cached 15 minutes in KV.",
    caveats:
      "Rows are crawl-report days, so gaps are possible. Crawled and Errors fall back to sums of Bing's HTTP-status buckets when the summary fields are missing.",
  },
  "bing.crawl-issues": {
    measures:
      "Problems Bingbot found while crawling, grouped by issue type with the number of affected URLs. The header counts issue TYPES rated Error or Warning.",
    source: "Bing Webmaster API GetCrawlIssues (issue flags decoded per URL).",
    window: "Bing's current issue list. Cached 60 minutes in KV.",
    caveats:
      "The header counts categories, not URLs: 1 error can mean hundreds of URLs. One URL can appear in several types. Not Bing's Site Scan tool, which the API doesn't expose.",
  },
  "bing.index-coverage": {
    measures:
      "Bing's in-index page count divided by the total URL count of every sitemap feed Bing lists for us.",
    source: "Bing Webmaster API GetCrawlStats (latest InIndex) over GetFeeds (sum of UrlCount).",
    window:
      "Latest crawl day over the current feed list. Crawl data cached 15 minutes, feeds 60 minutes.",
    caveats:
      "The top number is site-wide, not limited to sitemap URLs, so it can exceed 100%. The bottom adds every feed, so duplicate www and non-www sitemaps, or an index plus its children, are double-counted and lower the percentage.",
    thresholds:
      "Green above 95%; amber from 90 to 95%; red below 90%. Below 90% also adds an Action item.",
  },
  "bing.submitted-sitemaps": {
    measures:
      "Each sitemap feed Bing knows about, with its submitted date, last-crawled date, URL count and status.",
    source: "Bing Webmaster API GetFeeds.",
    window: "The current feed list. Cached 60 minutes in KV.",
    caveats:
      "Bing's date field names are unconfirmed, so a dash may mean the field wasn't recognised rather than missing. The warning above the table flags www and non-www duplicates.",
  },
  "bing.indexnow-operations": {
    measures:
      "IndexNow pipeline state and submission counts: sent in the last 24 hours and 7 days, failed and skipped in 24 hours, plus Bing's URL-submission quota left today.",
    source: "D1 indexnow_submissions; RATE_LIMIT_KV breaker keys; Bing API GetUrlSubmissionQuota.",
    window: "24-hour and 7-day windows, read live. Quota cached 60 minutes.",
    caveats:
      "Counts are submission batches, not URLs. While the indexnow:paused flag is set, blocked pings count as skipped. The quota is for Bing's separate URL Submission API, not IndexNow.",
    thresholds: "Green when Active; amber when Paused or in Cooldown.",
  },
  "bing.action-items": {
    measures:
      "Problems pulled from this tab's data: IndexNow paused or in cooldown, duplicate sitemaps, crawl errors, coverage below 90%, error-level crawl issues, and IndexNow failures in 24 hours.",
    source: "The Bing API reports and IndexNow state already loaded on this tab.",
    window: "Uses each input's own window and cache; see those cards.",
    caveats:
      "A Bing report that failed to load adds nothing here, so 'No action items — healthy' can mean nothing was measured. Warning-level crawl issues aren't included.",
    thresholds:
      "An item is added for each rule that fires: crawl errors above 0, coverage below 90%, any Error-level issue type, or any IndexNow failure in 24 hours.",
  },
} satisfies Record<string, TileDefinition>;
