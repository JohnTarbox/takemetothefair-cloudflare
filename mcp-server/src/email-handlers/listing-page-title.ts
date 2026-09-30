/**
 * OPE-1123 — a LISTING page is not an event.
 *
 * Inbound 2fca1d1d ("Thomas College Craft Fair") linked two thomas.edu index
 * pages beside its body prose. The body produced the right event (Sat 9/26,
 * e6a6a6fa); each index page produced a second "event" named after the PAGE —
 * "Upcoming Events: Thomas College, Waterville, Maine" and "Events Happening on
 * Campus: Thomas College: Maine" — dated with whatever else the page listed
 * (the 9/25–27 Homecoming span). Three junk rows, each for an operator to
 * reject.
 *
 * Deliberately narrow: only a name that OPENS with a listing phrase, only a
 * URL-sourced candidate (body prose and posters are the sender's words), and
 * only when some other candidate survives — a submission whose one source is a
 * listing page keeps its candidate for a person to judge, rather than silently
 * becoming "we found nothing".
 */

const LISTING_TITLE =
  /^\s*(upcoming\s+events|events\s+happening|events?\s+calendar|calendar\s+of\s+events|all\s+events|what'?s\s+happening|news\s+(and|&)\s+events|events\s+(list|listing|schedule))\b/i;

export function isListingPageTitle(name: string | null | undefined): boolean {
  return !!name && LISTING_TITLE.test(name);
}

export interface ListingCheckCandidate {
  name: string | null | undefined;
  kind: "url" | "body" | "attachment";
}

/** Indices of candidates to drop: listing-titled URL candidates, if anything else survives. */
export function listingCandidatesToDrop(cands: ListingCheckCandidate[]): number[] {
  const drop = cands
    .map((c, i) => (c.kind === "url" && isListingPageTitle(c.name) ? i : -1))
    .filter((i) => i >= 0);
  return drop.length > 0 && drop.length < cands.length ? drop : [];
}
