/**
 * OPE-456 — moved to `@takemetothefair/utils` (OPE-456 follow-up, 2026-08-19).
 *
 * The derivation is now consumed by the MCP `get_data_health_report` invariant
 * as well as the app, and the two are separate builds — so the rule lives in
 * the shared package, per this repo's convention. Re-exported here so existing
 * imports keep working and the move is not a breaking change.
 */
export {
  deriveCrossings,
  auditStoredDates,
  type DailyTotal,
  type Crossing,
  type DateAudit,
  type DateVerdict,
} from "@takemetothefair/utils";
