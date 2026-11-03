/**
 * OPE-1293 — the ONE rule for "is this capability flag dark?", shared by the
 * main app's resolver (`src/lib/analytics-overview/dark-capabilities.ts`) and
 * the MCP Worker's Monday inventory, which resolves the MCP-owned flags from
 * its own env. Two copies of an inverted rule is how the next one gets read
 * backwards and reported healthy.
 *
 * Each special case mirrors its consumer's production rule EXACTLY:
 *
 *   ENRICHMENT_DRY_RUN     inverted — `env.ENRICHMENT_DRY_RUN !== "false"`
 *                          (enrichment/select-candidates.ts, promoter-select.ts),
 *                          so UNSET means dry-run is ON, i.e. dark.
 *   AUTO_REPLY_ENABLED     default-open — `env.AUTO_REPLY_ENABLED !== "false"`
 *                          (mcp-server/src/email-gates.ts), so only the exact
 *                          string "false" holds the acks (OPE-1394).
 *   FAQ_PILOT_EVENT_SLUGS  a comma-separated slug allow-list, not a boolean
 *                          (src/lib/faq-pilot.ts): dark when it names no slug
 *                          (OPE-1394).
 *
 * Every other flag is lit only at exactly "true".
 */
export function isCapabilityFlagDark(name: string, value: string | null | undefined): boolean {
  const v = value ?? null;
  if (name === "ENRICHMENT_DRY_RUN") return v !== "false";
  if (name === "AUTO_REPLY_ENABLED") return v === "false";
  if (name === "FAQ_PILOT_EVENT_SLUGS") {
    return (v ?? "").split(",").every((s) => s.trim().length === 0);
  }
  return v !== "true";
}
