/**
 * OPE-1206 — the source says one state, the venue says another.
 *
 * `portland-holiday-market` was the Portland, OREGON show (its source is
 * portlandholidaymarket.com, Portland Expo Center OR) and sat on the Portland,
 * MAINE Expo venue for six months with 1,019 views. The name path had already
 * been made location-aware (OPE-1146); an EXPLICIT venue — a caller-supplied
 * `venue_id`, a form's picked venue, the URL-import wizard's chosen venue — was
 * linked without comparing it to the state the source itself gives.
 */

/** The six states MMATF covers. */
export const NEW_ENGLAND_STATE_CODES = ["CT", "MA", "ME", "NH", "RI", "VT"] as const;

function code(s: string | null | undefined): string | null {
  const c = s?.trim().toUpperCase();
  return c && /^[A-Z]{2}$/.test(c) ? c : null;
}

export function isNewEnglandState(state: string | null | undefined): boolean {
  const c = code(state);
  return !!c && (NEW_ENGLAND_STATE_CODES as readonly string[]).includes(c);
}

/**
 * The conflict, or null. Only a KNOWN two-letter state on BOTH sides can
 * conflict — a missing or unparseable state is not evidence of anything, and
 * refusing on it would drop every venue whose source says nothing.
 */
export function venueStateConflict(
  sourceState: string | null | undefined,
  venueState: string | null | undefined
): { sourceState: string; venueState: string } | null {
  const s = code(sourceState);
  const v = code(venueState);
  return s && v && s !== v ? { sourceState: s, venueState: v } : null;
}

/** A source outside New England is not auto-approved: a human looks first. */
export function sourceOutsideNewEngland(sourceState: string | null | undefined): boolean {
  const c = code(sourceState);
  return !!c && !isNewEnglandState(c);
}
