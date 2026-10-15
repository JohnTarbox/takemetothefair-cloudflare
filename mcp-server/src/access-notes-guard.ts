/**
 * OPE-1151 — `events.access_notes` is PUBLIC visitor copy, rendered verbatim on
 * the event page. Until OPE-1151 it rendered nowhere (its only reader was the
 * audience badge, null at PUBLIC + OPEN), so lanes parked analyst prose in it:
 * "2026-08-03 sweep: …", "VENUE CHECK: …", "observed: … | source: inbound
 * email …", "— do not merge", "OPE-272 … audit capture". Nine rows moved to
 * `event_internal_notes` in drizzle/0367.
 *
 * This refuses the SHAPES that prose took, at the writer, so the column does
 * not refill now that it is visible. It is a backstop for the obvious cases,
 * not a classifier: visitor copy that cites the organizer ("per the
 * organizer", "when checked on October 6, 2026") passes on purpose.
 *
 * Every pattern here matched at least one real prod row on 2026-10-15 and none
 * of the 56 rows judged visitor-facing (see access-notes-guard-ope1151.test.ts).
 */
const PROSE_SHAPES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bsweep:/i, what: 'a sweep finding ("… sweep: …")' },
  { pattern: /\bVENUE CHECK\b/i, what: "a venue check" },
  { pattern: /^\s*observed:/i, what: 'an "observed:" capture note' },
  { pattern: /\bOPE-\d+\b/, what: "a ticket reference (OPE-…)" },
  { pattern: /\bdo not merge\b/i, what: "a merge instruction" },
  { pattern: /\bverify(?:\/fix)? our\b/i, what: "an instruction to us" },
  { pattern: /\bsource: inbound email\b/i, what: "an inbound-email citation" },
  { pattern: /\bneeds (?:manual check|organizer confirmation)\b/i, what: "a to-do" },
  { pattern: /\bat the time of entry\b/i, what: "a note about our own data entry" },
];

/** Null when `text` may be published; otherwise what it looked like. */
export function accessNotesProseReason(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const { pattern, what } of PROSE_SHAPES) {
    if (pattern.test(text)) return what;
  }
  return null;
}
