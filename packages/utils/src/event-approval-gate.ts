/**
 * OPE-244 #3 — the ingest invariant that keeps invalid Event schema out of prod
 * at the source: an event may not be APPROVED (public) with NO venue AND NOT
 * marked statewide. Such an event has no derivable `location`, so it either
 * ships invalid Event JSON-LD or (post-#1/#4) a placeholder — neither is a real
 * place. The durable fix moves the check from render-time to ingest-time.
 *
 * Pure + shared so the admin approve route and the MCP `update_event_status`
 * tool enforce ONE definition (app and MCP are separate builds — a duplicated
 * check would drift).
 */

export interface EventApprovalGateInput {
  /** events.venue_id — null when no physical venue is linked. */
  venueId: string | null | undefined;
  /** events.is_statewide — true for venue-less-by-design statewide events. */
  isStatewide: boolean | null | undefined;
  /** events.state_code — a statewide event still needs a state to derive a location. */
  stateCode?: string | null | undefined;
}

/**
 * Returns a human-readable reason the event may NOT be approved, or null when
 * it's fine. Only blocks the specific invalid shape (no venue AND not
 * statewide, or statewide without a state code) — everything else passes.
 */
export function eventApprovalBlockReason(e: EventApprovalGateInput): string | null {
  const hasVenue = e.venueId != null && e.venueId !== "";
  if (hasVenue) return null;

  if (!e.isStatewide) {
    return (
      "Event has no venue and is not marked statewide — it would have no location " +
      "in its Event schema. Link a venue, or set is_statewide=true with a state_code."
    );
  }
  // Statewide but no state → still no derivable location.
  if (!e.stateCode) {
    return (
      "Event is marked statewide but has no state_code — a statewide event still " +
      "needs a state to derive its location. Set state_code."
    );
  }
  return null;
}

/**
 * OPE-1114 — a reviewer's note left in PUBLIC copy.
 *
 * `pemaquid-oyster-festival-2026` was approved and served with a description
 * ending "VENUE TO CONFIRM … reviewer should confirm the 2026 venue before
 * approval" — and the venue WAS wrong, by a town, five days out. The row had
 * written down, in public, that nobody had checked, and shipped anyway.
 *
 * Returns the matched marker, or null. Used to WARN at approval, never to
 * block: a false positive must not be able to stop a correct approval.
 *
 * The patterns are instructions to a reviewer, not hedges to a reader. Two
 * live rows say "hours subject to confirmation", which is honest reader-facing
 * copy, and must NOT match — hence upper-case-only for the terse markers
 * (`TO CONFIRM`, `TO VERIFY`, `TODO`) and phrases for the rest.
 */
const REVIEWER_MARKERS: ReadonlyArray<RegExp> = [
  /\breviewers? should\b/i,
  /\bbefore approv(?:al|ing)\b/i,
  /\bNEEDS VERIFICATION\b/i,
  /\bTO CONFIRM\b/,
  /\bTO VERIFY\b/,
  /\bTODO\b/,
];

export function reviewerMarkerInCopy(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const re of REVIEWER_MARKERS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** The warning both approve paths return. One wording, one place. */
export function reviewerMarkerWarning(marker: string): string {
  return (
    `This event's public description contains a reviewer note ("${marker}"). ` +
    `It was approved anyway (this is a warning, not a block) — check the note ` +
    `was resolved, and move it out of the public copy.`
  );
}
