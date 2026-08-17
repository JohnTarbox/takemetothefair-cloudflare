/**
 * OPE-423 — a merged event is a tombstone, and a tombstone must stay dead.
 *
 * ---------------------------------------------------------------------------
 * What actually happened (forensics, not theory)
 * ---------------------------------------------------------------------------
 *
 * The reported symptom was `bar-harbor-fall-craft-fair-2026` sitting APPROVED
 * with `merged_into` set — a row that is tombstoned and live at the same time,
 * duplicating `arts-at-atlantic-oceanside-october` on the same venue, the same
 * dates and the same series.
 *
 * The obvious diagnosis — "the merge wrote its steps non-atomically" — is
 * WRONG, and worth recording so nobody re-fixes the wrong thing. `mergeEvents`
 * (src/lib/duplicates/merge-operations.ts) issues the slug rename, the
 * slug-history insert, the REJECTED+merged_into update and the audit row in a
 * single `db.batch([...])`, which D1 runs as an implicit transaction. It cannot
 * half-commit, and `admin_actions` proves it did not:
 *
 *   2026-06-01 00:40:22  event.merge          slug → …-merged-9a395062,
 *                                             status → REJECTED, pointer set.
 *                                             Correct and complete.
 *   2026-06-25 05:18:10  event.status_change  REJECTED → APPROVED   ← here
 *   2026-06-25 05:18:16  event.update         15 fields incl. slug,
 *                                             renamed back to the original
 *
 * Twenty-four days after a clean merge, something walked up to the tombstone,
 * saw a REJECTED event that looked like a real fair, re-approved it, and
 * renamed its slug back. Both writes succeeded because **no write path on
 * `events` has ever consulted `merged_into`.** The status_change payload even
 * recorded the slug as `bar-harbor-fall-craft-fair-2026-merged-9a395062` — the
 * evidence was in the caller's hand and there was no rule to check it against.
 *
 * So this is not a torn write. It is a missing invariant, and the resurrection
 * is silent: it produces a healthy-looking APPROVED row, which is why it sat
 * for seven weeks until a human reconciled against the organizer's own list.
 *
 * ---------------------------------------------------------------------------
 * Why a shared pure function
 * ---------------------------------------------------------------------------
 *
 * Same reasoning as `eventApprovalBlockReason` beside it: the app and the MCP
 * server are separate builds with separate write surfaces
 * ([[feedback_mcp_server_is_separate_write_surface]]). A check duplicated in
 * both drifts, and the half that drifts is the half nobody is looking at. One
 * definition, imported by every caller that can move an event's status or slug.
 *
 * Deliberately NOT blocked here:
 *   - transitions INTO 'REJECTED' — that is the tombstone's own resting state,
 *     so re-asserting it is idempotent and harmless.
 *   - edits to non-identity fields (description, hours, citations). A tombstone
 *     is kept as an audit record; correcting a fact on it is legitimate and
 *     never makes it public.
 *
 * The only escape is to genuinely un-merge — clear `merged_into` deliberately,
 * with an audit row — which is what the message tells the caller to do. That
 * path is intentionally not a one-flag override on these tools: an override
 * argument would be passed by exactly the kind of caller this guard exists to
 * stop.
 */

/** The two columns the tombstone rule needs. Structural, so both the app's
 *  Drizzle rows and the MCP server's rows satisfy it without adapters. */
export interface MergedTombstoneGateInput {
  /** events.merged_into — non-null means this row was merged INTO another. */
  mergedInto: string | null | undefined;
}

/** What the caller is trying to do. Both optional: a caller changing only the
 *  status passes `nextStatus`, one changing only the slug passes `slugChange`,
 *  and `update_event` can pass both in a single call. */
export interface MergedTombstoneIntent {
  /** The status the caller wants to write, if it is changing one. */
  nextStatus?: string | null | undefined;
  /** True when the caller wants to change this event's slug. */
  slugChange?: boolean;
}

/**
 * Returns a human-readable reason this write must not proceed, or null when
 * it is fine.
 *
 * Returns null for every event that is not a merged tombstone, so callers can
 * apply it unconditionally without first asking whether it is relevant.
 */
export function mergedTombstoneBlockReason(
  e: MergedTombstoneGateInput,
  intent: MergedTombstoneIntent
): string | null {
  const keeperId = e.mergedInto;
  if (keeperId == null || keeperId === "") return null;

  // Re-asserting REJECTED on a tombstone is a no-op, not a resurrection.
  const resurrecting =
    intent.nextStatus != null && intent.nextStatus !== "" && intent.nextStatus !== "REJECTED";

  if (resurrecting) {
    return (
      `This event was merged into ${keeperId} and is a tombstone — its slug 301s ` +
      `to the keeper. Setting status='${intent.nextStatus}' would put a duplicate ` +
      `of the keeper back into the public index at the same venue and dates. ` +
      `If the merge itself was wrong, un-merge deliberately (clear merged_into ` +
      `with an audit row) and re-merge in the correct direction — do not ` +
      `re-approve the tombstone.`
    );
  }

  if (intent.slugChange) {
    return (
      `This event was merged into ${keeperId} and is a tombstone. Its slug is ` +
      `parked at '<original>-merged-<id8>' precisely so the original URL stays ` +
      `free for the keeper's 301. Renaming it would take that URL back and break ` +
      `the redirect. Un-merge deliberately if the merge was wrong.`
    );
  }

  return null;
}
