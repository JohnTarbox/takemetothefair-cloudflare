/**
 * OPE-1293 — the ONE rule for "is this capability flag dark?", shared by the
 * main app's resolver (`src/lib/analytics-overview/dark-capabilities.ts`) and
 * the MCP Worker's Monday inventory, which resolves the MCP-owned flags from
 * its own env. Two copies of an inverted rule is how the next one gets read
 * backwards and reported healthy.
 *
 * `ENRICHMENT_DRY_RUN` is inverted, and mirrors the production rule EXACTLY:
 * `env.ENRICHMENT_DRY_RUN !== "false"` (enrichment/select-candidates.ts,
 * promoter-select.ts) — so UNSET means dry-run is ON, i.e. dark. Every other
 * flag is lit only at exactly "true".
 */
export function isCapabilityFlagDark(name: string, value: string | null | undefined): boolean {
  const v = value ?? null;
  return name === "ENRICHMENT_DRY_RUN" ? v !== "false" : v !== "true";
}
