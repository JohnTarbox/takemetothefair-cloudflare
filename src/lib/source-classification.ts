/**
 * Re-export shim. The implementation lives in @takemetothefair/utils so the
 * MCP server can import the same classifier without mirror-discipline
 * overhead. Mirrors the event-date-gates.ts re-export pattern.
 */
export {
  classifySource,
  INGESTION_METHODS,
  type IngestionMethod,
  type SourceClassification,
} from "@takemetothefair/utils";
