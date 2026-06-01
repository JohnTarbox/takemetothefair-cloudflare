/**
 * Rule registry. Add new rules here; the engine picks them up automatically on
 * the next scan.
 */

import type { RuleDefinition } from "../engine";
import { enhancedProfileCohortRule } from "./enhanced-profile-cohort";
import {
  enhancedProfileRenewalCriticalRule,
  enhancedProfileRenewalNoticeRule,
  enhancedProfileRenewalWarningRule,
} from "./enhanced-profile-renewals";
import { eventsMissingApplicationUrlRule } from "./events-missing-application-url";
import { seoPosition1120Rule } from "./seo-position-11-20";
import {
  eventsShortDescriptionRule,
  vendorsShortDescriptionRule,
  venuesShortDescriptionRule,
} from "./short-descriptions";
import { slugSuffixDuplicatesRule } from "./slug-suffix-duplicates";
import { softDeletedVenuesRule } from "./soft-deleted-venues";
import { staleYearEventsRule } from "./stale-year-events";
import { staticPagesShortDescriptionRule } from "./static-pages-short-description";
import { vendorsNoDescriptionRule } from "./vendors-no-description";
import { stubsReadyForEnrichmentRule } from "./stubs-ready-for-enrichment";
import { standardsEligibleForClaimOutreachRule } from "./standards-eligible-for-claim-outreach";
import { claimedReadyForEnhancedUpsellRule } from "./claimed-ready-for-enhanced-upsell";
import { lowCtrPagesRule } from "./low-ctr-pages";
import { page1ZeroClickQueriesRule } from "./page-1-zero-click-queries";
import { slugQualityDriftRule } from "./slug-quality-drift";
import { hijackedDomainDetectionRule } from "./hijacked-domain-detection";
import { cannibalizationDetectionRule } from "./cannibalization-detection";
import { competitorUrlContaminationRule } from "./competitor-url-contamination";
import { longSnoozedItemsRule } from "./long-snoozed-items";
import { confirmPastEventOccurrenceRule } from "./confirm-past-event-occurrence";
import { eventDateDriftRule } from "./event-date-drift";
import { eventsPendingReviewRule } from "./events-pending-review";
import { eventsLegacyGateCandidatesRule } from "./events-legacy-gate-candidates";
import { memoryRuleConversionStatusRule } from "./memory-rule-conversion-status";
import { venuesNamedByAddressRule } from "./venues-named-by-address";

export const ALL_RULES: RuleDefinition[] = [
  vendorsNoDescriptionRule,
  enhancedProfileCohortRule,
  seoPosition1120Rule,
  eventsMissingApplicationUrlRule,
  eventsShortDescriptionRule,
  venuesShortDescriptionRule,
  vendorsShortDescriptionRule,
  slugSuffixDuplicatesRule,
  staleYearEventsRule,
  softDeletedVenuesRule,
  staticPagesShortDescriptionRule,
  enhancedProfileRenewalCriticalRule,
  enhancedProfileRenewalWarningRule,
  enhancedProfileRenewalNoticeRule,
  // Tier-transition rules (PR D): surface tier-graduation opportunities.
  stubsReadyForEnrichmentRule,
  standardsEligibleForClaimOutreachRule,
  claimedReadyForEnhancedUpsellRule,
  // SEO + data-quality rules from doc §10.4 (PR L). Note: page_2_close_calls
  // is doc-listed but already shipped as seoPosition1120Rule above.
  lowCtrPagesRule,
  // Page-1 zero-click queries (analyst Item 2, Phase 2 spec, 2026-05-30).
  // Complement to low_ctr_pages: catches the harsher "zero clicks despite
  // page-1 rank" failure mode that needs a fundamental snippet rewrite,
  // not a tweak. 7-day window vs 28-day on low-ctr — recent regressions.
  page1ZeroClickQueriesRule,
  slugQualityDriftRule,
  hijackedDomainDetectionRule,
  cannibalizationDetectionRule,
  competitorUrlContaminationRule,
  longSnoozedItemsRule,
  // Lifecycle audit (PR #157 follow-up): triage the 203 events auto-tagged
  // OCCURRED by migration 0067's backfill. Drops out as soon as admin
  // confirms the lifecycle (any transition writes admin_actions).
  confirmPastEventOccurrenceRule,
  // Daily re-verification finding surfacer (analyst backlog #1, 2026-05-16).
  // Lights up when the cron detects > 1 day drift between stored start_date
  // and the canonical source URL.
  eventDateDriftRule,
  // Pre-ingest gate triage queue (analyst backlog #1 follow-up, 2026-05-17).
  // PENDING events flagged by evaluateGates() that admin hasn't yet reviewed.
  eventsPendingReviewRule,
  // Retroactive scanner — APPROVED events that pre-date the 2026-05-16 gate
  // rollout (or have drifted since) and would now route to PENDING_REVIEW.
  eventsLegacyGateCandidatesRule,
  // Memory-rule conversion backlog (analyst Item 5f, 2026-05-30). Tier-3
  // process surface — reads from a hand-curated static list in the rule's
  // source file (memory lives on the fs, not in D1).
  memoryRuleConversionStatusRule,
  // Cohort 8 (C9/U9, 2026-06-01). Venues whose stored name looks like a
  // raw street address (e.g. "18 Spring Street"). Display-side falls back
  // to "Event venue in <City>, <State>" via displayVenueName; this rule
  // surfaces the rows so the operator can rename via the venue edit form.
  venuesNamedByAddressRule,
];
