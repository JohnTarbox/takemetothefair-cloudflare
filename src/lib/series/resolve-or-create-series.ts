/**
 * OPE-472 — shim. The implementation moved to `@takemetothefair/event-series`
 * so the MCP Worker (a separate build) can call the SAME resolver; see the
 * package for the full rationale and the grouping-key argument.
 *
 * Kept as a re-export because the app's call sites — public `/suggest-event`,
 * admin create, import-url, and the MCP twins' app-side counterparts — already
 * import from here, and a shim is cheaper and safer than touching five ingest
 * paths to prove a point about module layout.
 */
export {
  seriesNameKey,
  stripNameEditionSuffix,
  resolveOrCreateSeries,
  attachEventToSeries,
  orphanEventCondition,
  type ResolveSeriesInput,
  type ResolveSeriesResult,
  type SeriesSkipReason,
} from "@takemetothefair/event-series";
