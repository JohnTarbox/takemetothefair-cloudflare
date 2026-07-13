/**
 * OPE-175 — fill-empty-only enrichment proposals for dedup-on-match.
 *
 * When an inbound submission dedups to an EXISTING event, we don't mutate the
 * live (usually APPROVED) event. Instead we capture the subset of fields the
 * email could FILL that are currently empty, and stage them for operator review
 * (John's call 2026-07-13: fill-empty only, land PENDING). This module is the
 * pure decision — "which fields would we propose?" — so the fill-empty-only
 * invariant is unit-tested independently of the Durable-Object workflow.
 *
 * Invariant: a field is proposed ONLY when the existing value is empty AND the
 * incoming value is non-empty. A populated existing field is never proposed, so
 * curated data can never be overwritten by this path.
 */

const isEmpty = (v: string | null | undefined): boolean => v == null || v.trim().length === 0;

/** Existing event's current values for the three enrichable fields. */
export interface ExistingEnrichFields {
  imageUrl?: string | null;
  sourceUrl?: string | null;
  description?: string | null;
}

/** Values carried by the inbound submission (imageUrl/description from the
 *  extracted event; sourceUrl from the submission's source URL). */
export interface IncomingEnrichFields {
  imageUrl?: string | null;
  sourceUrl?: string | null;
  description?: string | null;
}

/**
 * Return the fill-empty proposals keyed by DB column name (`image_url`,
 * `source_url`, `description`). Empty object when nothing is proposable.
 */
export function computeFillEmptyProposals(
  existing: ExistingEnrichFields,
  incoming: IncomingEnrichFields
): Record<string, string> {
  const out: Record<string, string> = {};
  const consider = (
    col: string,
    current: string | null | undefined,
    next: string | null | undefined
  ) => {
    if (isEmpty(current) && !isEmpty(next)) out[col] = (next as string).trim();
  };
  consider("image_url", existing.imageUrl, incoming.imageUrl);
  consider("source_url", existing.sourceUrl, incoming.sourceUrl);
  consider("description", existing.description, incoming.description);
  return out;
}
