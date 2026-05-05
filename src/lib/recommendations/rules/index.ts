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
import { slugQualityDriftRule } from "./slug-quality-drift";
import { hijackedDomainDetectionRule } from "./hijacked-domain-detection";
import { cannibalizationDetectionRule } from "./cannibalization-detection";
import { competitorUrlContaminationRule } from "./competitor-url-contamination";
import { longSnoozedItemsRule } from "./long-snoozed-items";

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
  slugQualityDriftRule,
  hijackedDomainDetectionRule,
  cannibalizationDetectionRule,
  competitorUrlContaminationRule,
  longSnoozedItemsRule,
];
