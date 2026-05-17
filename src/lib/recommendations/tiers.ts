/**
 * §10.3 business-impact tier classification for recommendation rules.
 *
 * Restructures the recommendations grid by impact tier rather than just
 * severity color. Within a tier, severity (red/yellow/blue) still drives
 * card border + sort order.
 *
 * - T1 revenue: rules whose resolution directly affects MMATF revenue
 *   (Enhanced Profile sales pipeline, vendor claim conversions)
 * - T2 SEO defense: rules that prevent SEO regressions or revenue leakage
 *   to competitors (hijacked domains, competitor URL contamination,
 *   keyword cannibalization)
 * - T3 content quality: rules that improve crawler signals over time but
 *   don't move the immediate revenue or defense needle
 *
 * Unmapped rules fall into T3 by default (most-conservative impact bucket).
 */
export type Tier = "T1" | "T2" | "T3";

export const TIER_BY_RULE_KEY: Record<string, Tier> = {
  // T1: revenue
  enhanced_profile_cohort: "T1",
  standards_eligible_for_claim_outreach: "T1",
  claimed_ready_for_enhanced_upsell: "T1",
  enhanced_profile_renewals: "T1",

  // T2: SEO defense
  hijacked_domain_detection: "T2",
  competitor_url_contamination: "T2",
  cannibalization_detection: "T2",
  event_date_drift: "T2",
  events_pending_review: "T2",
  events_legacy_gate_candidates: "T2",

  // T3: content quality
  vendors_no_description: "T3",
  vendors_short_description: "T3",
  stubs_ready_for_enrichment: "T3",
  confirm_past_event_occurrence: "T3",
};

export function tierFor(ruleKey: string): Tier {
  return TIER_BY_RULE_KEY[ruleKey] ?? "T3";
}

export const TIER_META: Record<Tier, { label: string; description: string; sortOrder: number }> = {
  T1: {
    label: "Tier 1 — Revenue",
    description: "Resolution directly affects Enhanced Profile sales or vendor-claim conversions.",
    sortOrder: 1,
  },
  T2: {
    label: "Tier 2 — SEO defense",
    description: "Prevents SEO regressions or revenue leakage to competitors / aggregators.",
    sortOrder: 2,
  },
  T3: {
    label: "Tier 3 — Content quality",
    description: "Improves crawler signals over time; lower immediate impact than T1/T2.",
    sortOrder: 3,
  },
};

/**
 * Within-tier priority score for the unified opportunities feed. Higher = more
 * important. Combines severity weight + match count so a high-severity rule
 * with 1 match beats a low-severity rule with 100, but a low-severity rule
 * with 100 beats high-severity with 0.
 */
export function opportunityScore(severity: "red" | "yellow" | "blue", matchCount: number): number {
  // Spread chosen so a high-severity rule with 1 match always outranks a
  // lower-severity rule even at the count cap (99). Within a severity, the
  // clamped match count is the tiebreaker.
  const sevWeight = severity === "red" ? 10000 : severity === "yellow" ? 1000 : 100;
  return sevWeight + Math.min(matchCount, 99);
}
