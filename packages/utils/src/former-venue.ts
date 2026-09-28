/**
 * OPE-1180 — FORMER venues: EDTF date bounds, lifecycle validation, and the
 * date guard every event write path applies before referencing a venue.
 *
 * Why: on 2026-09-27 a fabricated "Montpelier Fairgrounds" (blank address,
 * city-centroid coordinates) carried four phantom gun-show events, and Google's
 * AI Overview blended that with the real history of an 1866–1881 trotting-track
 * fairground, citing us. There was no honest way to say "this WAS a fair venue
 * from X to Y": `venues.status` was only ACTIVE | INACTIVE, and INACTIVE is the
 * hidden merge tombstone.
 *
 * Pure: callers load the venue row; this decides. Shared by the main app and
 * the MCP Worker so both surfaces enforce one rule.
 */

// ── EDTF (Extended Date/Time Format, Level 0/1 subset) ─────────────────────

export interface EdtfBounds {
  /** Earliest instant the expression can denote (UTC). */
  earliest: Date;
  /** Latest instant the expression can denote (UTC, end of its last day). */
  latest: Date;
  /** `~` approximate, `?` uncertain, `%` both — widened by one year each side. */
  qualified: boolean;
}

/**
 * Parse the subset of EDTF the venue history needs:
 *   `1956`  `1956-06`  `1956-06-14`   — year / month / day precision
 *   `195X`  `19XX`  `1956-XX`         — unspecified digits
 *   `1956~` `1956?` `1956%`           — approximate / uncertain / both
 *
 * Returns null for anything else — including an empty string — so a caller
 * can refuse a malformed value instead of storing an unusable bound.
 *
 * Qualified dates are WIDENED by one year each side. EDTF gives `~` no numeric
 * width, and the guard's job is to stay on the safe side: an approximate
 * closure must not make a real event just before it look post-closure, and must
 * not make one just after it look safe without a review flag.
 */
export function parseEdtfBounds(input: string | null | undefined): EdtfBounds | null {
  if (!input) return null;
  const m = /^(\d{2}[\dX]{2})(?:-(\d{2}|XX))?(?:-(\d{2}|XX))?([~?%])?$/.exec(input.trim());
  if (!m) return null;
  const [, yearRaw, monthRaw, dayRaw, qualifier] = m;
  // A day with no month (`1956--14`) cannot match the regex; an unspecified
  // month with a specified day (`1956-XX-14`) is not meaningful here.
  if (monthRaw === "XX" && dayRaw && dayRaw !== "XX") return null;

  const yearLo = Number(yearRaw.replace(/X/g, "0"));
  const yearHi = Number(yearRaw.replace(/X/g, "9"));
  let loMonth = 1;
  let hiMonth = 12;
  if (monthRaw && monthRaw !== "XX") {
    const mm = Number(monthRaw);
    if (mm < 1 || mm > 12) return null;
    loMonth = hiMonth = mm;
  }
  let loDay = 1;
  let hiDay = daysInMonth(yearHi, hiMonth);
  if (dayRaw && dayRaw !== "XX") {
    const dd = Number(dayRaw);
    if (dd < 1 || dd > daysInMonth(yearLo, loMonth)) return null;
    loDay = hiDay = dd;
  }

  const qualified = !!qualifier;
  const widen = qualified ? 1 : 0;
  const earliest = new Date(Date.UTC(yearLo - widen, loMonth - 1, loDay, 0, 0, 0));
  const latest = new Date(Date.UTC(yearHi + widen, hiMonth - 1, hiDay, 23, 59, 59));
  return { earliest, latest, qualified };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ── Lifecycle validation ───────────────────────────────────────────────────

export const VENUE_CURRENT_STATES = ["REPURPOSED", "VACANT", "DEMOLISHED", "UNKNOWN"] as const;
export type VenueCurrentState = (typeof VENUE_CURRENT_STATES)[number];

export const CLAIM_CERTAINTIES = ["certain", "less-certain", "uncertain"] as const;
export type ClaimCertainty = (typeof CLAIM_CERTAINTIES)[number];

export interface VenueLifecycleInput {
  status: string;
  useStartedEdtf?: string | null;
  useEndedEdtf?: string | null;
}

export interface VenueLifecycleDerived {
  useEndedEarliest: Date | null;
  useEndedLatest: Date | null;
}

/**
 * Validate the lifecycle fields and derive the closure bounds, or return the
 * reason they are refused. FORMER requires `use_ended_edtf` (OpenHistoricalMap:
 * a feature with no end date is still there); an unparseable EDTF value is
 * refused on any status; an end before a start is refused.
 */
export function validateVenueLifecycle(
  input: VenueLifecycleInput
): { ok: true; derived: VenueLifecycleDerived } | { ok: false; error: string } {
  const started = input.useStartedEdtf ? parseEdtfBounds(input.useStartedEdtf) : null;
  if (input.useStartedEdtf && !started) {
    return {
      ok: false,
      error: `use_started_edtf "${input.useStartedEdtf}" is not a supported EDTF date (e.g. 1956, 1956-06, 1956~, 195X).`,
    };
  }
  const ended = input.useEndedEdtf ? parseEdtfBounds(input.useEndedEdtf) : null;
  if (input.useEndedEdtf && !ended) {
    return {
      ok: false,
      error: `use_ended_edtf "${input.useEndedEdtf}" is not a supported EDTF date (e.g. 1881, 1881-10, 1881~, 188X).`,
    };
  }
  if (input.status === "FORMER" && !ended) {
    return {
      ok: false,
      error:
        "A FORMER venue needs use_ended_edtf — a venue with no end date is treated as still in use.",
    };
  }
  if (started && ended && ended.latest.getTime() < started.earliest.getTime()) {
    return { ok: false, error: "use_ended_edtf is before use_started_edtf." };
  }
  return {
    ok: true,
    derived: {
      useEndedEarliest: ended?.earliest ?? null,
      useEndedLatest: ended?.latest ?? null,
    },
  };
}

// ── The date guard ─────────────────────────────────────────────────────────

export interface GuardVenue {
  id: string;
  name: string;
  status: string;
  useEndedEdtf?: string | null;
  useEndedEarliest: Date | null;
  useEndedLatest: Date | null;
}

export type FormerVenueVerdict =
  | { kind: "allow" }
  /** Inside the closure's uncertainty window, or the event has no date. */
  | { kind: "flag"; reason: string }
  | { kind: "refuse"; message: string };

/**
 * May an event whose last day is `eventEnd` reference `venue`?
 *
 *   venue not FORMER            → allow (the guard only speaks about closures)
 *   eventEnd ≤ closure earliest → allow  (a real past event at the old grounds)
 *   within [earliest, latest]   → flag   (cannot tell which side of the closure)
 *   eventEnd > closure latest   → refuse (the grounds were gone)
 *   no eventEnd                 → flag   (cannot check; a human must)
 *
 * A FORMER row with no derived bounds is treated as refuse-everything-dated —
 * validation should make it impossible, and failing closed is the safe way to
 * be wrong about a venue that no longer exists.
 */
export function checkFormerVenue(
  venue: GuardVenue | null | undefined,
  eventEnd: Date | null | undefined
): FormerVenueVerdict {
  if (!venue || venue.status !== "FORMER") return { kind: "allow" };
  const closed = venue.useEndedEdtf ?? "an unknown date";
  if (!eventEnd) {
    return {
      kind: "flag",
      reason: `venue "${venue.name}" closed ${closed}; this event has no date to check against it`,
    };
  }
  const earliest = venue.useEndedEarliest?.getTime();
  const latest = venue.useEndedLatest?.getTime();
  const t = eventEnd.getTime();
  if (earliest !== undefined && t <= earliest) return { kind: "allow" };
  if (earliest !== undefined && latest !== undefined && t <= latest) {
    return {
      kind: "flag",
      reason: `event date falls inside the closure window of "${venue.name}" (closed ${closed})`,
    };
  }
  return {
    kind: "refuse",
    message:
      `Venue "${venue.name}" (${venue.id}) is a FORMER venue that closed ${closed}, ` +
      `and this event ends ${eventEnd.toISOString().slice(0, 10)} — after the closure. ` +
      "An event after a venue closed cannot be held there: attach the venue it actually used, or leave the venue empty.",
  };
}
