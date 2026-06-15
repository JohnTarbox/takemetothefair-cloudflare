/**
 * Re-export shim. The canonical `normalizeName` now lives in the shared
 * workspace package `@takemetothefair/utils` (packages/utils/src/duplicates.ts)
 * so the MCP server — a separate workspace that cannot import from `src/` — can
 * key K27's auto-rollover idempotency on the same normalization the main app's
 * dedup uses. This file remains so existing `@/lib/duplicates/normalize-name`
 * imports (find-duplicate.ts, goodwill/ingest-discrepancy.ts, and the unit
 * test) keep working unchanged.
 *
 * See the source for the strip rules and the Winthrop Arts Festival case that
 * locks them in.
 */
export { normalizeName } from "@takemetothefair/utils";
