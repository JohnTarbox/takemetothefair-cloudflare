/**
 * OPE-1151 — `events.access_notes` is PUBLIC visitor copy: per-category
 * admission, accessibility, who may attend. It renders on every event page
 * that has it, whatever the audience/access pair.
 *
 * Before this, its only reader was `formatAudienceBadge` (event-audience.ts),
 * which returns null at the PUBLIC + OPEN default and interpolates the note
 * only for MEMBERS + OPEN when it is under 50 characters. No event with a
 * note was MEMBERS on 2026-10-15, so none of the 65 notes reached any page
 * (Guilford's senior rate, Pemaquid's "first floor is fully accessible").
 * The TRADE / CLOSED pages that seemed to show theirs were showing a copy of
 * the same sentences in `description`.
 *
 * Analyst prose does NOT belong in this column; it lives in the private
 * `event_internal_notes` table (drizzle/0367).
 */
export function publicAccessNotes(accessNotes: string | null | undefined): string | null {
  const trimmed = accessNotes?.trim();
  return trimmed ? trimmed : null;
}
