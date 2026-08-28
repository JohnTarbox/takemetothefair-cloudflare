/**
 * OPE-435 — what `events.gate_flags` should become after a re-evaluation.
 *
 * ── Why this is a shared helper and not two inline branches ────────────────
 * Two handlers write this column: the main app's admin PATCH
 * (`src/app/api/admin/events/[id]/route.ts`) and the MCP `update_event` tool
 * (`mcp-server/src/tools/admin.ts`). Both carried the same defect, and a fix
 * applied to one would have left the other still producing the stale flags
 * this ticket is about. Making the decision a single pure function means the
 * two paths cannot drift, and the rule can be tested without standing up
 * either handler.
 *
 * ── The defect it fixes ───────────────────────────────────────────────────
 * The write used to live inside `if (route === "PENDING_REVIEW")`, so the
 * column was ADD-ONLY: a repaired row kept a flag asserting a condition that
 * no longer held. Live specimen — `ba1eaea4` sat at exactly `12:00:00Z`, the
 * canonical clean anchor where `dateLooksTimezoneConfused` returns `false`
 * immediately, and still carried `["start_date_timezone_confused"]`.
 *
 * The cost is not tidiness. A channel that cries wolf gets ignored, and it
 * was: an analyst approved an event on 2026-08-24 whose `end_date_in_past`
 * flag was visibly impossible on a November 2026 event — "I did ignore it. It
 * was inert, the approve went through, and I only checked because the value
 * looked impossible."
 */

export interface NextGateFlagsInput {
  /** `events.gate_flags` as currently stored — JSON array string, or null. */
  currentFlags: string | null | undefined;
  /** `evaluateGates(...).route` for the POST-MERGE view of the row. */
  route: "APPROVED" | "PENDING_REVIEW";
  /** `evaluateGates(...).reasons`. */
  reasons: readonly string[];
}

export interface NextGateFlagsResult {
  /** False when the column should be left entirely alone (no write). */
  write: boolean;
  /** The value to store when `write` is true. `null` means clear. */
  value: string | null;
  /** Reasons to surface as a warning, or null when the row is clean. */
  warning: string[] | null;
}

export function nextGateFlags(input: NextGateFlagsInput): NextGateFlagsResult {
  const flagged = typeof input.currentFlags === "string" && input.currentFlags.trim().length > 0;

  if (input.route === "PENDING_REVIEW") {
    const reasons = [...input.reasons];
    return { write: true, value: JSON.stringify(reasons), warning: reasons };
  }

  // Clean verdict.
  //
  // Wholesale clearing is correct rather than lossy, and this is the part
  // worth stating: `evaluateGates` is the SINGLE evaluator for every reason
  // this column can hold — the date gates, the name gates,
  // `source_tier_3_aggregator`, `source_tabular_multirow_pdf` — and it returns
  // `route: "APPROVED"` exactly when `reasons` is empty. So a clean verdict is
  // an authoritative statement that nothing applies at all, not merely that
  // the date gates passed. Preserving "sibling" flags here would be preserving
  // reasons the same evaluator just declined to produce.
  if (flagged) return { write: true, value: null, warning: null };

  // Never flagged and still clean: no write. Writing null here would bump
  // `updated_at` on rows with no user-visible change, and since OPE-308 that
  // is a real change signal driving sitemap `lastmod` and the conditional-GET
  // validator — it would tell search engines a page changed when it did not.
  return { write: false, value: null, warning: null };
}
