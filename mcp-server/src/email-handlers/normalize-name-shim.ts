/**
 * OPE-378 — the MCP server needs the same event-name normalization the main app
 * uses for dedup (`src/lib/duplicates/normalize-name.ts`), and cannot import
 * across that boundary.
 *
 * Kept byte-identical in behaviour on purpose: if the two drift, an in-batch
 * cluster and a cross-catalog dedup would disagree about whether two rows are
 * the same event, which is the divergence class that produced the slug bug
 * (#120) and the Winthrop duplicate.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*\d+(st|nd|rd|th)\s+/i, "") // leading ordinal: "38th "
    .replace(/^\s*annual\s+/i, "")
    .replace(/\s+\d{4}\s*$/, "") // trailing year
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
