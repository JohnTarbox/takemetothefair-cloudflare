import type { TileDefinition } from "./types";

export const RECOMMENDATIONS_TILES = {
  "recommendations.top-opportunities": {
    measures:
      "The 10 individual Search Console query items with the most impressions across all active recommendation rules, each with clicks, position and a suggested fix.",
    source: "recommendation_items payloads (stored from Search Console) for gsc_query targets.",
    window:
      "Active items: seen by a scan in the last 7 days, not done, not snoozed. Figures are as of that scan.",
    caveats:
      "Only gsc_query items with a query and numeric impressions appear; other rule types never do. Shows 'pos 0' or '0 clicks' when the payload lacks those fields. Sorted by impressions only, not severity.",
  },
  "recommendations.top-rules": {
    measures:
      "Up to 10 rules with active items, ranked by severity first (red, yellow, blue) and then by how many active items each has.",
    source: "Active recommendation_items grouped by recommendation_rules.",
    window: "Active items: seen by a scan in the last 7 days, not done, not snoozed. Read live.",
    caveats:
      "'Impact' is severity plus item count (count capped at 99 for ranking), not traffic or revenue. The tier chip is shown but does not affect order. Rules with no active items are not listed.",
  },
  "recommendations.rule-group": {
    measures:
      "One recommendation rule: how many of its items are active now, a week-over-week change chip, and how long since the rule last scanned.",
    source: "recommendation_items and recommendation_rules (total_match_count, last_scanned_at).",
    window:
      "Active items: seen by a scan in the last 7 days, not done, not snoozed. The chip compares with 7 days ago.",
    caveats:
      "The chip compares different populations: now counts only active, unsnoozed items; 7 days ago counts every item first seen by then and not yet done, including snoozed and aged-out ones, so it leans towards a drop. In 'N of M', M is the scanner's raw match count.",
    thresholds:
      "Chip amber when the count rose, green when it fell. Scan badge red when the rule never scanned or last scanned more than 24 hours ago.",
  },
  "recommendations.scan-freshness": {
    measures:
      "Every enabled recommendation rule, stalest first, with how long since it last completed a scan and whether its latest attempt errored.",
    source: "recommendation_rules (last_scanned_at, last_scan_error), enabled rules only.",
    window: "Current state, read live on page load.",
    caveats:
      "Includes rules with zero matches. A failed attempt keeps the older success time. The daily scan works through rules in chunks and a full sweep can take more than a day, so red is not always a fault.",
    thresholds:
      "Badge red when never scanned or last scanned more than 24 hours ago; 'last scan errored' when last_scan_error is set. The Overview tile uses 48 hours instead.",
  },
} satisfies Record<string, TileDefinition>;
