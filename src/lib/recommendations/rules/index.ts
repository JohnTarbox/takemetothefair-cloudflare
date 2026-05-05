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
];
