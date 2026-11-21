/**
 * OPE-1613 — which feed events MMATF publishes.
 *
 * The rules live in @takemetothefair/utils/feeds since OPE-1625 (the main app's
 * test-submission engine applies the same filter); this module re-exports them
 * so the MCP Worker's imports stay where they were.
 */
export {
  CAMP_WORKSHOP_PATTERNS,
  DEFAULT_INCLUSION_RULES,
  campsWorkshopsOptInActive,
  isRegisteredPromoter,
  decideInclusion,
  parseInclusionRules,
  type CampsWorkshopsPromoter,
  type FeedInclusionRules,
  type InclusionOptions,
  type InclusionVerdict,
} from "@takemetothefair/utils/feeds";
