/**
 * OPE-1146 — may a venue row that matched by NAME be linked to a submission?
 *
 * "Veterans Memorial Park", "Town Hall", "Fairgrounds", "Grange Hall" exist in
 * dozens of New England towns. Both venue matchers linked on the name and let
 * location break ties at best: `suggest_event` fell back to the first same-name
 * row whatever its state, and `autoLinkVenue` linked a lone same-name row even
 * when the states disagreed. That put Old Orchard Beach, ME's Veterans
 * Memorial Park onto a Norwalk, CT venue: wrong map pin, wrong state browse
 * page, wrong distance search, and reported as a successful match.
 *
 * The rule: a name match stands only if the STATE agrees when both sides have
 * one, and the CITY agrees when both sides have one. A blank on either side is
 * not a disagreement — K44's reason for reusing a row whose stored city was
 * empty still holds.
 */
export function venueLocationCompatible(
  candidate: { city?: string | null; state?: string | null },
  input: { city?: string | null; state?: string | null }
): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const cs = norm(candidate.state);
  const is = norm(input.state);
  if (cs && is && cs !== is) return false;
  const cc = norm(candidate.city);
  const ic = norm(input.city);
  if (cc && ic && cc !== ic) return false;
  return true;
}
