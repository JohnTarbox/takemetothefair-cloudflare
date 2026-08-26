/**
 * OPE-549 item 4 — naming the sections a search could not reach.
 *
 * `/search` fans out to four independent queries under `Promise.allSettled`, so
 * one failure degrades that section to an empty array. The rejection was always
 * logged, but the page rendered a failure and a genuine zero identically —
 * HTTP 200, "No results found" — so the person whose query broke the events
 * query was told, in as many words, that no events matched.
 *
 * That is why the LIKE-pattern family (315 errors, 27 days, five call sites)
 * ran for a month unnoticed: nobody reports a search that politely finds
 * nothing.
 *
 * Extracted rather than inlined so the phrasing is testable. It is user-facing
 * copy on an error path, which is the copy least likely to be looked at again.
 */

/**
 * Join section labels into a readable clause: "events", "events and venues",
 * "events, venues and blog posts".
 *
 * Oxford comma deliberately omitted to match the rest of the site's copy.
 * Returns "" for an empty list so a caller that forgets to guard renders
 * nothing rather than the word "undefined".
 */
export function formatSectionList(sections: readonly string[]): string {
  if (sections.length === 0) return "";
  if (sections.length === 1) return sections[0];
  return `${sections.slice(0, -1).join(", ")} and ${sections[sections.length - 1]}`;
}
