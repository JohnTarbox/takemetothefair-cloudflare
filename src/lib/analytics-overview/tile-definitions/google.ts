import type { TileDefinition } from "./types";

/**
 * OPE-1159 — Google tab (GoogleTab + GscMilestoneChartCard in
 * src/app/admin/analytics/page.tsx). Each entry is written from the call that
 * computes the number (src/lib/search-console.ts, loadGscMilestones), not from
 * the card label.
 */
export const GOOGLE_TILES = {
  "google.milestones": {
    measures:
      "Click-count thresholds the site crossed in a rolling 28-day window: Google's emailed badges plus crossings we derive from our own daily GSC totals.",
    source: "D1 gsc_milestone_emails (metric clicks, 28-day window, meetmeatthefair.com only).",
    window:
      "All milestones ever recorded; the chart plots from 2026-05-01. Read live on each page load. Plotted on the date reached, not the email date.",
    caveats:
      "Google skips badges (it jumped 1.5K to 3K), so badges alone under-report growth. Latest, Earliest, Milestones and May ramp use the full series, not just the plotted points. A milestone appears only once an email is ingested or a crossing derived.",
  },
  "google.total-clicks": {
    measures:
      "Total Google search clicks for the whole property, with impressions and the date range underneath.",
    source:
      "Search Console Search Analytics API, one query with no dimensions (property aggregate).",
    window: "28 days, from 30 days ago to 3 days ago. Cached 15 minutes in KV.",
    caveats:
      "Search Console data lags about 2 to 3 days, so the newest days are excluded. Shows Unavailable, not 0, when the API call fails.",
  },
  "google.top25-query-clicks": {
    measures:
      "Clicks summed over just 25 queries: the 25 with the most impressions, not the most clicks. Sub-line shows their query count and impressions.",
    source:
      "Search Console Search Analytics API, query x page rows, rowLimit 25 (over-fetches 250 rows).",
    window: "28 days, from 30 days ago to 3 days ago. Cached 15 minutes in KV.",
    caveats:
      "Not the site total; use Total clicks for that. Queries are ranked by impressions, so high-click queries can be left out. A query's clicks count only the query-page rows inside the 250-row fetch. About 2 to 3 days of data lag.",
  },
  "google.sitemap-status": {
    measures:
      "Indexed: URLs whose last URL Inspection verdict in our sweep was PASS. Submitted: URL total Google reports across our submitted sitemaps. Also shows sitemap errors and warnings.",
    source:
      "D1 gsc_inspection_state (indexed); Search Console Sitemaps API (submitted, errors, warnings).",
    window:
      "Indexed is read live; each verdict dates from that URL's last sweep. Sitemap figures are cached 24 hours in KV.",
    caveats:
      "Indexed is a subset: it counts only URLs our rotating sweep has inspected, not everything Google has indexed. It is not limited to current sitemap URLs, so the two numbers are different populations. Google's own per-sitemap indexed count returns 0 and is not used.",
  },
  "google.top-queries": {
    measures:
      "The 25 queries with the most Google impressions, showing each one's clicks, impressions, CTR and impression-weighted average position.",
    source: "Search Console Search Analytics API, query x page rows merged per query.",
    window: "28 days, from 30 days ago to 3 days ago. Cached 15 minutes in KV.",
    caveats:
      "Ranked by impressions, not clicks. Only the query-page rows inside the 250-row fetch are summed, so long-tail pages of a query can be missing. About 2 to 3 days of data lag.",
  },
  "google.submitted-sitemaps": {
    measures:
      "Each sitemap submitted to Search Console, with its submitted URL count, warnings, errors, last-read date and last-submitted date.",
    source: "Search Console Sitemaps API (sitemaps.list).",
    window: "The current sitemap list. Cached 24 hours in KV.",
    caveats:
      "Google's per-sitemap indexed column is deprecated and always 0, so it is left out. Last read is when Google last downloaded the file, not when it indexed the URLs.",
  },
} satisfies Record<string, TileDefinition>;
