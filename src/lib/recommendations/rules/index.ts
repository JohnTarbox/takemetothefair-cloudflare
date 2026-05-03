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
import { vendorsNoDescriptionRule } from "./vendors-no-description";

export const ALL_RULES: RuleDefinition[] = [
  vendorsNoDescriptionRule,
  enhancedProfileCohortRule,
  seoPosition1120Rule,
  eventsMissingApplicationUrlRule,
  eventsShortDescriptionRule,
  venuesShortDescriptionRule,
  vendorsShortDescriptionRule,
  enhancedProfileRenewalCriticalRule,
  enhancedProfileRenewalWarningRule,
  enhancedProfileRenewalNoticeRule,
];
