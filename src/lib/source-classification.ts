/**
 * Re-export shim. The implementation lives in @takemetothefair/utils so the
 * MCP server can import the same classifier without mirror-discipline
 * overhead. Mirrors the event-date-gates.ts re-export pattern.
 */
export {
  classifySource,
  INGESTION_METHODS,
  // OPE-491 — the fall-through default + the allowlist assertion. This shim
  // names its exports explicitly, so a new symbol in the package is NOT
  // automatically reachable from the app; it has to be added here too.
  UNLABELED_SOURCE,
  assertIngestionMethod,
  isIngestionMethod,
  type IngestionMethod,
  type SourceClassification,
} from "@takemetothefair/utils";
