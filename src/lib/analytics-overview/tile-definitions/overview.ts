import type { TileDefinition } from "./types";

export const OVERVIEW_TILES = {
  "overview.site-health": {
    measures:
      "Count of open Site Health issues (not resolved, not currently snoozed), split into errors, warnings and notices.",
    source:
      "health_issues with health_issue_snoozes: Bing scan, Bing and GSC sitemaps, GSC URL inspection, email delivery.",
    window:
      "Current open state, not windowed. Read live on each page load; only as fresh as the last sweep that wrote each issue.",
    caveats:
      "Snoozed issues drop out until the snooze expires. GSC URL-inspection and email-delivery issues close only through their own checks, not the regular refresh, so they can linger after a fix.",
    thresholds:
      "Red border when any ERROR issue is open; amber when there are no errors but at least one WARNING.",
  },
  "overview.action-queue": {
    measures:
      "Prioritised to-do list: P0 for KPIs currently RED or STALE, P1 for YELLOW KPIs and for Tier-1 recommendation rules with 50 or more matches.",
    source: "kpi_state_history (latest row per KPI) and recommendation_rules.total_match_count.",
    window:
      "Latest recorded KPI state (recomputed every 10 minutes); the YELLOW suppression looks back 7 days. Read live.",
    caveats:
      "A YELLOW KPI that was RED any time in the last 7 days is held out of the list and named in a 'suppressed' line instead. STALE rows mean a dead feed, not a breach. Rule rows use the scanner's raw match count.",
    thresholds:
      "SLA chip on KPI rows, from first detection: amber past half the limit, red (breached) past 24h for P0 or 72h for P1. STALE rows never age.",
  },
  "overview.admin-actions": {
    measures:
      "Number of rows written to the admin audit log in the last 7 days, with the 8 most recent listed.",
    source: "admin_actions.",
    window: "Fixed trailing 7 days from page load; ignores the window selector. Read live.",
    caveats:
      "Not only people: automated writers log here too, for example the KPI recompute's kpi.state_resolved rows. The list shows at most 8 entries.",
  },
  "overview.blog-coverage": {
    measures:
      "Events, vendors and venues that no blog post links to, shown against the total of each and summed.",
    source: "content_links (blog post links) compared with events, vendors and venues.",
    window: "Current state, not windowed. Read live on each page load.",
    caveats:
      "Coverage means a link from a PUBLISHED post to an entity in the total: APPROVED events, non-deleted vendors, all venues. Draft-post links don't count. A link to a renamed slug may not resolve to an id.",
    thresholds:
      "A group's figure turns amber at 50% or more uncovered and red at 90% or more; the card border follows the worst group.",
  },
  "overview.recommendations-summary": {
    measures:
      "Actionable recommendation items: every red item plus yellow items from Tier-1 or Tier-2 rules. Also shows total items, rule count and the red/yellow/blue split.",
    source:
      "recommendation_items joined to enabled recommendation_rules; tier comes from the rule key.",
    window:
      "Items a scan saw in the last 7 days that are not done and not snoozed. Read live on page load.",
    caveats:
      "Blue items and Tier-3 yellow items count in the total but not as actionable. If scans stop, items age out after 7 days and the number falls towards zero, which looks like a clean site.",
    thresholds:
      "Border follows the worst severity present (red, amber, blue), including non-actionable items. Shows 'scanner stopped' when no rule has scanned successfully in 48 hours.",
  },
  "overview.indexnow-today": {
    measures:
      "IndexNow submissions actually sent to Bing since midnight UTC (success plus failure), the success rate over those, and how many the breaker deferred.",
    source: "indexnow_submissions; remaining daily quota from the Bing Webmaster API.",
    window: "Since 00:00 UTC today, read live. The Bing quota is cached for up to 60 minutes.",
    caveats:
      "Breaker-deferred ('skipped') rows are shown separately, not counted as sent. 'Paused' is read from the indexnow:paused KV flag; 'pause state unknown' means that read failed. 'Last sent' is the last day Bing was contacted.",
    thresholds:
      "Red border and text when any row today has status failure. Skipped rows never turn it red.",
  },
  "overview.recent-errors": {
    measures:
      "Number of ERROR-level rows written to the error log in the last 24 hours, with the three sources that logged the most.",
    source: "error_logs, level = error, every source.",
    window: "Rolling 24 hours from page load; ignores the window selector. Read live.",
    caveats:
      "Info and warn rows are not counted (routine logging such as the recommendations scan's info rows). Counts rows, so one repeating fault can dominate.",
    thresholds: "Red border when more than 10 error rows were logged in 24 hours.",
  },
  "overview.render-fault-health": {
    measures:
      "Seven figures on the render-fault ledger: open vs total signatures, auto-filed share, mean time to detect, server-render share, dedup collapse, recurrence and guard coverage.",
    source: "fault_signatures (the whole ledger) and error_logs.",
    window:
      "Ledger figures are all-time. Only server-message share uses the window selector (1, 7, 30 or 90 days). Read live.",
    caveats:
      "Server-message share is server-render rows over render-fault rows (server-render plus client) in the window. Guard coverage is not instrumented and always shows n/a. Open means any non-terminal status.",
    thresholds: "Amber border when any signature is open.",
  },
  "overview.queue-drain": {
    measures:
      "For each human work queue: current backlog, items added and items closed over the trailing 7 days, and closed divided by added.",
    source:
      "Each queue's own D1 table (discrepancies, enrichment candidates, inbound emails, health issues and others) plus queue_drain_snapshots.",
    window: "Trailing 7 days, computed live on page load; the slow-drain test uses 14 days.",
    caveats:
      "A dash means not measured, not zero. Some queues' outflow comes from daily snapshots and stays blank until history exists. Uses the same tunable_thresholds overrides as the daily alert.",
    thresholds:
      "FROZEN (red) when it has a backlog and 0 closed in the window (default 7 days); SLOW (amber) when closing fewer than 0.5 per item added over 14 days (default ratio).",
  },
  "overview.heartbeat-probes": {
    measures:
      "For each shipped writer, cron or pipeline with a probe: when it last produced its expected D1 evidence, and whether it has gone silent.",
    source: "Each probe's own evidence query (HEARTBEAT_PROBES) plus heartbeat_probes.enabled_at.",
    window:
      "Read live. Each probe has its own window; silence counts from the newest evidence, or from enablement if there is none.",
    caveats:
      "Dormant probes (no enabled_at) are never judged. 'ok' only means some evidence arrived inside the window, not that the output was correct.",
    thresholds:
      "SILENT (red row and border) when time since last evidence exceeds the probe's window; the same test escalates to the operator digest.",
  },
  "overview.user-activity": {
    measures:
      "The latest visitor clicks on an event's ticket or application link, newest first, at most 10.",
    source:
      "analytics_events rows named outbound_ticket_click or outbound_application_click (browser beacon).",
    window: "The page's window selector (1, 7, 30 or 90 days; default 7). Read live.",
    caveats:
      "A list, not a count. No bot filtering is applied to beacon events. Contact clicks, favorites and other engagement events are not included.",
  },
  "overview.operator-activity": {
    measures:
      "The latest admin audit-log actions and successful IndexNow pings for new venues, new vendors and event approvals, merged newest first, at most 10.",
    source:
      "admin_actions; indexnow_submissions with status success from venue.create, vendor.create or event.approve.",
    window: "The page's window selector (1, 7, 30 or 90 days; default 7). Read live.",
    caveats:
      "Admin actions include automated writers. Skipped, failed and other-source IndexNow rows are left out, so while IndexNow is paused only admin actions appear.",
  },
} satisfies Record<string, TileDefinition>;
