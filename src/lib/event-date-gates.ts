/**
 * Pre-ingest date-quality gates.
 *
 * The implementation lives in `@takemetothefair/utils` so the MCP server's
 * vendor.suggest_event tool can import the same gate logic without
 * mirror-discipline overhead. This file is a re-export shim — change
 * `packages/utils/src/event-date-gates.ts` if you need to update the gates.
 */

export {
  evaluateGates,
  nameMatchesAdminFlag,
  dateLooksImplausible,
  sourceCredibilityTier,
  sourceLooksLikeMultirowPdf,
  type IngestEvaluationInput,
  type IngestEvaluationResult,
  type NameFlagResult,
  type DateGateInput,
  type DateGateResult,
} from "@takemetothefair/utils";
