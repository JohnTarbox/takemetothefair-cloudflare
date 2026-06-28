/**
 * Backward-compat shim. Canonical implementation moved to
 * `packages/utils/src/duplicates.ts` so the MCP server (separate workspace)
 * can share it without duplication. Existing call sites importing from
 * `@/lib/duplicates/similarity` keep working unchanged.
 */
export {
  normalizeString,
  levenshteinDistance,
  levenshteinSimilarity,
  tokenize,
  jaccardSimilarity,
  tokenJaccardSimilarity,
  combinedSimilarity,
  findDuplicatePairs,
  getVenueComparisonString,
  getEventComparisonString,
  getVendorComparisonString,
  normalizeVendorName,
  getPromoterComparisonString,
} from "@takemetothefair/utils";
