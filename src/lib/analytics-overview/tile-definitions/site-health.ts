import type { TileDefinition } from "./types";

/**
 * OPE-1159 — Site Health tab. Written from SiteHealthTab / buildSiteHealthGroups
 * in src/app/admin/analytics/page.tsx, src/lib/site-health.ts (getCurrentIssues),
 * src/lib/site-health-classify.ts and src/lib/site-health-unified/*.
 */
export const SITE_HEALTH_TILES = {
  "site-health.instrument.technical": {
    measures:
      "Open action-tier site-health issues: ERROR plus WARNING rows that are not expected non-indexing and not actively snoozed.",
    source:
      "health_issues joined to health_issue_snoozes (Bing Site Scan, Bing/GSC sitemaps, GSC URL Inspection).",
    window:
      "All unresolved rows of any age, read live. Bing/sitemap rows refresh daily at 06:00 UTC; inspection rows only when their URL is re-swept.",
    caveats:
      "NOTICE rows are never counted. Rows not re-verified in 14 days still count in full; staleness only greys their group below. Rich-result failures are named in the detail line, not weighted.",
    thresholds:
      "Red (critical) if any action error; amber (attention) if only action warnings; green at zero. Feeds the verdict banner.",
  },
  "site-health.instrument.data": {
    measures:
      "Event-data discrepancies currently open: event_discrepancies rows with resolution_status 'open', counted live.",
    source: "event_discrepancies (live count); goodwill_health_snapshots (trend and staleness).",
    window:
      "Live count at page load. The trend compares the oldest and newest of the latest 28 nightly snapshots.",
    caveats:
      "The whole open queue, not new problems, and there is no absolute cap. 'Growing' compares snapshot values, not the live count, so changes since the last nightly run are not in it.",
    thresholds:
      "Amber if the newest snapshot is over 2 days old or missing, or its open count exceeds the oldest in the 28-snapshot trend. Never red.",
  },
  "site-health.instrument.traffic": {
    measures:
      "A flag, not a session count: 1 when organic search sessions fell 25% or more week over week, otherwise 0. Sessions are in the line below.",
    source: "GA4 Data API: sessions filtered to sessionMedium = organic.",
    window:
      "7-day window ending two days ago (GA4 back-fill lag) versus the 7 days before it; queried on page load.",
    caveats:
      "Organic search from all engines, not raw users. GA4 dates are inclusive, so each window spans 8 calendar days and the two share a boundary day. A dash means GA4 failed, not zero traffic.",
    thresholds:
      "Amber at a week-over-week drop of 25% or more; never red. Grey 'unknown' when GA4 errors, which stops the verdict reading Healthy.",
  },
  "site-health.action-errors": {
    measures:
      "Open site-health rows with severity ERROR, excluding expected non-indexing rows and rows whose snooze has not expired.",
    source: "health_issues joined to health_issue_snoozes.",
    window: "All unresolved rows regardless of age, read live on page load.",
    caveats:
      "Counts individual URLs, not the groups in Action needed. Rows not re-verified in 14 days still count. The red number is fixed styling, not a threshold: zero is also red.",
  },
  "site-health.action-warnings": {
    measures:
      "Open site-health rows with severity WARNING, excluding expected non-indexing rows and rows whose snooze has not expired.",
    source: "health_issues joined to health_issue_snoozes.",
    window: "All unresolved rows regardless of age, read live on page load.",
    caveats:
      "Counts individual URLs, not groups. NOTICE rows are in neither this card nor Action errors. Rows not re-verified in 14 days still count. The amber number is fixed styling, not a threshold.",
  },
  "site-health.expected-count": {
    measures:
      "Open, unsnoozed site-health rows whose message matches a normal GSC coverage state, such as 'Discovered – currently not indexed' or 'Page with redirect'.",
    source: "health_issues joined to health_issue_snoozes; matched by message text.",
    window: "All unresolved rows regardless of age, read live on page load.",
    caveats:
      "Any severity, ERROR included. Matching uses six fixed message fragments; any other coverage state lands in Action instead. Rich-result failures never count here. Rows not re-verified in 14 days still count.",
  },
  "site-health.snoozed": {
    measures:
      "Open site-health rows whose snooze has not yet expired, across every tier and severity.",
    source: "health_issue_snoozes joined to unresolved health_issues.",
    window: "Snoozes with snoozed_until later than page-load time.",
    caveats:
      "Includes expected non-indexing and NOTICE rows, so it is not the gap between the other cards. Snoozed rows still appear, dimmed, inside the lists below. Leftover snoozes on resolved rows are not counted.",
  },
  "site-health.action-needed": {
    measures:
      "Unresolved site-health rows not matching an expected coverage state, grouped by source, issue type and message with digits folded.",
    source: "health_issues joined to health_issue_snoozes.",
    window:
      "All unresolved rows of any age, live. Bing/sitemap rows refresh daily at 06:00 UTC; GSC inspection rows only when re-inspected.",
    caveats:
      "Unlike the cards, groups include NOTICE rows and snoozed URLs, so they can total more than errors plus warnings. A group is marked stale only when its newest URL is over 14 days unverified; stale rows stay listed and counted.",
  },
  "site-health.expected-non-indexing": {
    measures:
      "Unresolved site-health rows whose message matches a normal GSC coverage state, grouped by source, issue type and message; collapsed by default.",
    source: "health_issues joined to health_issue_snoozes.",
    window: "All unresolved rows regardless of age, read live on page load.",
    caveats:
      "Includes snoozed URLs (dimmed), so group totals can exceed the Expected card. A real problem whose message contains one of the six fragments is hidden here. Stale groups are greyed, not removed.",
  },
  "site-health.unclassified-outbound": {
    measures:
      "Outbound ticket-click destination domains with 5 or more clicks that have no row in url_domain_classifications.",
    source: "analytics_events (outbound_ticket_click beacons) and url_domain_classifications.",
    window: "Rolling last 7 days from page load, queried live.",
    caveats:
      "Ticket clicks only; website, application and contact clicks are ignored. Clicks are raw beacon rows, not unique visitors. Domains under 5 clicks are hidden, not absent. Hostname matched exactly after stripping 'www.'.",
  },
  "site-health.data-health": {
    measures:
      "The Goodwill discrepancy queue: open discrepancies, outreach candidates and weighted priority now, plus 28-day resolution counts and a nightly-snapshot trend.",
    source: "event_discrepancies, admin_actions (discrepancy.*), goodwill_health_snapshots.",
    window:
      "Open counts live. Resolutions and overrides: last 28 days. Trend: newest 28 snapshots, flagged stale when over 2 days old.",
    caveats:
      "Operator overrides counts every discrepancy.create and discrepancy.resolve admin action, not only overrides. Adjudicated coverage excludes superseded bookkeeping and is blank when nothing was judged. Resolutions bucket by resolved_at.",
  },
  "site-health.traffic": {
    measures:
      "Organic search sessions in GA4 for the latest 7-day window, the window before it, and the percentage change between them.",
    source: "GA4 Data API: sessions where sessionMedium is organic.",
    window:
      "7 days ending two days ago (GA4 back-fill lag) versus the prior 7 days; fetched on page load.",
    caveats:
      "Organic search from all engines, not raw users or all sessions. GA4 dates are inclusive, so each '7d' window covers 8 days and the two share a boundary day. A dash means GA4 failed, not zero.",
  },
  "site-health.engagement": {
    measures:
      "First-party beacon event counts: intent and hand-off actions, engagement and conversion events, blog outbound-click targets and source posts, and zero-result internal searches.",
    source:
      "analytics_events (first-party beacons), grouped by event name, category and properties.",
    window: "Rolling last 30 days from page load, queried live.",
    caveats:
      "Raw event counts, not unique visitors, and not GA4. Lists are capped: top 10 blog targets, top 8 source posts, top 10 zero-result searches. Search logs as you type, so prefixes pad the zero-result list.",
  },
  "site-health.email-relationships": {
    measures:
      "Support-obligation queue by status, age of the oldest open one, and first-party newsletter and registration funnel event counts.",
    source: "support_obligations; analytics_events (newsletter_* and register_* beacons).",
    window: "Queue counts are all-time, live. Funnel counts cover the last 30 days.",
    caveats:
      "Confirm rate is confirms over submits in the same 30 days, so a confirm can belong to an earlier submit. The status list repeats the open count. Email opens, clicks and delivery are not measured.",
  },
} satisfies Record<string, TileDefinition>;
