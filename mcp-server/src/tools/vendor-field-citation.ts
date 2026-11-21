/**
 * OPE-1673 — a vendor fee or application deadline is never written without
 * the source that states it.
 *
 * Measured 2026-11-17 (OPE-816 re-measure): of the events carrying a vendor
 * fee or deadline, only one had a citation behind it. The vendor digest and
 * the December deadline calendar show these values to vendors as fact, so a
 * value with nothing behind it is indistinguishable from a guess.
 *
 * The two writers handle a missing citation differently, on purpose — the same
 * split OPE-1058 drew for categories:
 *
 * - `update_event` is a deliberate edit. It REFUSES the whole call before any
 *   write, so nothing is half-applied and the caller retries with the source.
 * - `suggest_event` is intake. It DROPS the uncited vendor values, creates the
 *   event anyway, and names the dropped fields in `warnings`. An event is worth
 *   having without its booth fee; a booth fee is not worth having without its
 *   source.
 *
 * Clearing a value (null) never needs a citation — removing an unsupported
 * claim is the safe direction.
 */

/** The fields this rule covers, by MCP param name (dollars / YYYY-MM-DD). */
export const VENDOR_CITED_FIELDS = [
  "vendor_fee_min",
  "vendor_fee_max",
  "application_deadline",
] as const;
export type VendorCitedField = (typeof VENDOR_CITED_FIELDS)[number];

/** The fields in `params` that set a vendor value (present and non-null). */
export function vendorFieldsBeingSet(params: Record<string, unknown>): VendorCitedField[] {
  return VENDOR_CITED_FIELDS.filter((f) => params[f] !== undefined && params[f] !== null);
}

/** True when the caller's citation carries the source's own wording. */
export function hasExcerpt(excerpt: string | null | undefined): boolean {
  return typeof excerpt === "string" && excerpt.trim().length > 0;
}

/**
 * `update_event`'s refusal text, or null when the call may proceed.
 * `citationNotes` is `citation.notes` — the excerpt slot on that tool.
 */
export function updateEventVendorCitationError(
  params: Record<string, unknown>,
  citation: { source_url: string; notes?: string | null } | undefined
): string | null {
  const setting = vendorFieldsBeingSet(params);
  if (setting.length === 0) return null;
  if (!citation) {
    return (
      `${setting.join(", ")} cannot be written without a citation (OPE-1673). ` +
      "Pass `citation` with the organizer page that states the value (source_url, source_type) " +
      "and the page's own wording in citation.notes — or omit the field. Pass null to clear a value."
    );
  }
  if (!hasExcerpt(citation.notes)) {
    return (
      `${setting.join(", ")} needs the source's wording in citation.notes (OPE-1673) — ` +
      `quote the line on ${citation.source_url} that states the fee or deadline.`
    );
  }
  return null;
}
