/**
 * OPE-1159 — Overview tab KPI cards (row 1, the §10.3/§6.3 KPI rows, and the
 * 30d/90d sparkline strips). Every entry is written from the loader that
 * computes the number (src/lib/analytics-overview/*.ts, src/lib/kpi-states.ts,
 * src/lib/ga4.ts, src/lib/search-console.ts), not from the card's label.
 */
import type { TileDefinition } from "./types";

export const OVERVIEW_KPI_TILES = {
  "overview.google-clicks": {
    measures:
      "Total Google search clicks for the whole property (an un-dimensioned GSC query), compared with the equal-length period just before it.",
    source: "Google Search Console API; the Bing footer line is Bing Webmaster GetQueryStats.",
    window:
      "Follows the window selector (default 7d). Presets end yesterday; 30d actually reads 28 days, 1d reads 2 days ending 3 days ago. Cached 15 min.",
    caveats:
      "Google only; Bing is added as a footer, never summed in. The Bing figure is rolling: it sums every row GetQueryStats returns and ignores the window. At 30d the prior period is 30 days against a 28-day current.",
  },
  "overview.conversions": {
    measures:
      "Count of outbound_ticket_click plus outbound_application_click events in the window, compared with the equal-length period just before it.",
    source: "D1 `analytics_events` (first-party click beacon).",
    window: "Follows the window selector (default 7d), rolling from now; live D1 read, no cache.",
    caveats:
      "Clicks out to a ticket or application URL, not purchases or submitted applications. Contact clicks are not counted. No bot or duplicate filter in the query. Shows the 🕒 chip if the newest analytics_events row of any kind is over 6h old.",
  },
  "overview.catalog-growth": {
    measures:
      "New rows created in the window: APPROVED events plus all venues plus all vendors, compared with the prior period. Footer shows all-time totals.",
    source: "D1 `events`, `venues`, `vendors` (created_at).",
    window: "Follows the window selector (default 7d), rolling from now; live D1 read.",
    caveats:
      "Events count only if APPROVED now (TENTATIVE, pending and later-rejected excluded), including past events. Venue and vendor counts have no status filter and include soft-deleted vendors, so they differ from Sitemap quality's vendor and event totals.",
  },
  "overview.enhanced-profile-revenue": {
    measures:
      "Vendors with the enhanced_profile flag set, multiplied by a hard-coded $29. Footer shows how many had enhanced_profile_started_at in the window.",
    source: "D1 `vendors` (enhanced_profile, enhanced_profile_started_at).",
    window:
      "Headline is all-time current state; the new count follows the window selector (default 7d). Live D1 read.",
    caveats:
      "Not billing data: counts the flag, not payments. Does not check expiry date or soft-deletion itself; an expired profile counts until the expiry sweep clears the flag. The $29 constant is not read from any pricing source.",
  },
  "overview.site-ctr": {
    measures:
      "Google clicks divided by impressions, summed over the top 500 queries (by impressions) GSC returns for the window. Previous line is the prior equal period.",
    source:
      "Google Search Console API (query plus page dimensions). Badge: D1 `gsc_daily_totals`, via `kpi_state_history`.",
    window:
      "Value follows the window selector (default 7d), N days ago through today. Cached 15 min. Badge: fixed 7 days ending 2 days ago.",
    caveats:
      "The value uses the top-500-query basis, which omits anonymized queries and the long tail. The badge is computed separately from unfiltered daily totals, so value and colour can disagree. The prior period shares one boundary day.",
    thresholds:
      "Badge: green at 2.0% or more, red below 1.0%, amber between. STALE if GSC data is over 120h old, or if the badge recompute stopped over 1h ago. Red or stale enters the action queue as P0.",
  },
  "overview.conversion-rate": {
    measures:
      "outbound_ticket_click plus outbound_application_click events divided by GA4 sessions whose medium is organic, over 7 days.",
    source: "D1 `analytics_events` (numerator) and the GA4 Data API (organic sessions).",
    window:
      "Fixed 7 days ending 48h ago (GA4 finalization lag); ignores the window selector. GA4 cached 10 min.",
    caveats:
      "The footer says ticket clicks but application clicks are counted too. The numerator counts clicks from every traffic source; the denominator is organic search sessions only, so the rate can exceed 100%. No bot filter on clicks.",
    thresholds:
      "Badge: green at 8% or more, red below 5%, amber between. STALE if GA4 data is over 96h old, or if the badge recompute stopped over 1h ago. Red or stale enters the action queue as P0.",
  },
  "overview.account-engagement": {
    measures:
      "Self-serve vendor claims plus event favorites plus outbound_contact_click events, divided by the count of every first-party analytics event in the window.",
    source:
      "D1 `admin_actions` (vendor.claim_self_serve), `user_favorites` (EVENT), `analytics_events`.",
    window: "Follows the window selector (default 7d), rolling from now; live D1 read.",
    caveats:
      "The denominator is all analytics_events rows of every type, not sessions or visitors, so this is not a per-visit rate. Claims and favorites come from other tables than the denominator. No colour or target.",
  },
  "overview.aeo-referrals": {
    measures:
      "GA4 sessions whose session source exactly matches a listed AI-engine domain: ChatGPT, Perplexity, Copilot, Claude, Gemini, plus an Other bucket.",
    source: "GA4 Data API (sessionSource, sessions).",
    window:
      "GA4 range 7daysAgo to today: 8 calendar days including today's partial day. Ignores the window selector. Cached 10 min.",
    caveats:
      "The Other bucket includes duckduckgo.com, so ordinary DuckDuckGo search visits count as AI referrals. Bing Copilot chat arrives as www.bing.com and is not counted. Only hostnames on the list count.",
    thresholds:
      "Display-only colour, not in the KPI state machine or action queue: green at 10 or more, amber 5 to 9, red below 5.",
  },
  "overview.facebook-traffic": {
    measures:
      "GA4 sessions (and summed active users) from Facebook sources such as facebook.com, m.facebook.com, l.facebook.com, fb.me and facebook.",
    source: "GA4 Data API source/medium report (the top 10 rows by sessions).",
    window:
      "GA4 range 28daysAgo to today, including today's partial day. Ignores the window selector. Cached 10 min.",
    caveats:
      "Only the top 10 source/medium rows are read; a Facebook row below the cut is missed (shown as a capped sample when 10 rows return). Users are summed across rows, so one person on two Facebook sources counts twice.",
  },
  "overview.brand-share": {
    measures:
      "Share of Google clicks, among the top 500 queries, whose query text contains meet me at the fair, meetmeatthefair, mmatf or take me to the fair.",
    source:
      "Google Search Console API (query plus page dimensions). Badge via `kpi_state_history`.",
    window:
      "Value follows the window selector (default 7d); 30d reads 28 days. Cached 15 min. Badge uses the 28 days ending 3 days ago.",
    caveats:
      "Top 500 queries only; anonymized queries are excluded entirely. The badge is computed separately on its own fixed window, so value and colour can disagree.",
    thresholds:
      "Badge, lower is better: green at 40% or less, red above 60%, amber between. STALE if GSC data is over 120h old or the recompute stopped over 1h ago. Red or stale is a P0 action.",
  },
  "overview.sitemap-quality": {
    measures:
      "Share of vendors and events whose completeness score is 40 or more, the sitemap inclusion gate. Footer gives the vendor and event pass counts.",
    source: "D1 `vendors` and `events` (completeness_score). Badge via `kpi_state_history`.",
    window: "Current state, all-time; live D1 read. Badge recomputed every 10 minutes.",
    caveats:
      "The value counts every event of any status (drafts, rejected, cancelled) and non-deleted vendors. The badge counts only publicly visible events, so value and colour can disagree. Not the same population as Catalog growth.",
    thresholds:
      "Badge: green at 75% or more, red below 60%, amber between. STALE if no vendor or event edited in 72h, or the recompute stopped over 1h ago. Red or stale is a P0 action.",
  },
  "overview.time-to-index": {
    measures:
      "Median, p90 and mean seconds from an IndexNow submission to the first Google crawl, over the most recent 1,000 resolved URLs.",
    source:
      "D1 `time_to_index_log` (lag_seconds), seeded by IndexNow submissions and resolved by the GSC sweep.",
    window:
      "Latest 1,000 resolved rows by first crawl time, any age; live D1 read. Badge uses rows first crawled in the last 30 days.",
    caveats:
      "Rows are only admitted on an IndexNow submission, and admission froze on 2026-06-13 (IndexNow paused), so this describes a closed cohort; stragglers still resolving push the median up. Median is the upper-middle value.",
    thresholds:
      "Badge on the 30-day median, lower is better: green at 24h or less, red above 72h. STALE when no row admitted in 7 days, which is where it sits. Stale or red is a P0 action.",
  },
  "overview.search-visibility-30d": {
    measures:
      "Daily Google search clicks for the whole property, one point per day, with the chart's total.",
    source: "Google Search Console API (date dimension).",
    window:
      "Last 30 calendar days, minus the unreported tail (usually the latest 3 days), so about 27 points. Ignores the window selector. Cached 15 min.",
    caveats: "Google only; no Bing. The total is the sum of the days drawn, not a full 30 days.",
  },
  "overview.conversions-30d": {
    measures:
      "Daily count of outbound_ticket_click plus outbound_application_click events, one point per UTC day, with the chart's total.",
    source: "D1 `analytics_events`.",
    window: "Last 30 UTC days including today; ignores the window selector. Live D1 read.",
    caveats:
      "Clicks out, not purchases or submitted applications. Contact clicks are not counted. No bot filter.",
  },
  "overview.publishing-30d": {
    measures: "Daily count of IndexNow submission rows with status success, one point per UTC day.",
    source: "D1 `indexnow_submissions`.",
    window: "Last 30 UTC days including today; ignores the window selector. Live D1 read.",
    caveats:
      "Counts successful IndexNow pings, not content published. Submissions are paused, so it reads zero whatever is published; skipped and failed rows are excluded. Shows the 🕒 chip when no success row falls in the chart.",
  },
  "overview.search-visibility-90d": {
    measures:
      "Daily Google search clicks for the whole property, one point per day, with the chart's total.",
    source: "Google Search Console API (date dimension).",
    window:
      "Last 90 calendar days, minus the unreported tail (usually the latest 3 days), so about 87 points. Ignores the window selector. Cached 15 min.",
    caveats: "Google only; no Bing. The total is the sum of the days drawn, not a full 90 days.",
  },
  "overview.conversions-90d": {
    measures:
      "Daily count of outbound_ticket_click plus outbound_application_click events, one point per UTC day, with the chart's total.",
    source: "D1 `analytics_events`.",
    window: "Last 90 UTC days including today; ignores the window selector. Live D1 read.",
    caveats:
      "Clicks out, not purchases or submitted applications. Contact clicks are not counted. No bot filter.",
  },
  "overview.publishing-90d": {
    measures: "Daily count of IndexNow submission rows with status success, one point per UTC day.",
    source: "D1 `indexnow_submissions`.",
    window: "Last 90 UTC days including today; ignores the window selector. Live D1 read.",
    caveats:
      "Rows older than 30 days are deleted by the retention job, so at most the last 30 days can ever show. Counts successful IndexNow pings, not content published; submissions are paused.",
  },
} satisfies Record<string, TileDefinition>;
