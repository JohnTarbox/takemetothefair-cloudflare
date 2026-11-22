/**
 * OPE-1697 — which fair a Snap upload is for, when more than one is close by.
 *
 * On 2026-11-21 the Snap page auto-pinned the NEAREST same-day event, silently,
 * and 13 of 15 booth photos taken at South Portland High School went to the
 * church fair ~350 m down the road. 11 of them auto-wrote CONFIRMED vendor
 * links to the wrong roster.
 *
 * The rule, shared by the capture page (what to auto-select) and the MCP
 * photo-intake guard (whether an upload may auto-write):
 *
 *   candidates = public events running on the phone's local date whose venue
 *                lies within `snapAmbiguityRadiusMiles(accuracy)` of the fix
 *   0 candidates  → nothing is auto-selected; the user picks
 *   1 candidate   → it may be auto-selected, and is SHOWN as the target
 *   >1 candidates → AMBIGUOUS: never auto-select, and an upload that was not
 *                   explicitly picked must not auto-write
 *
 * The radius is the ticket's `max(500 m, 2 × GPS accuracy)` with one more
 * floor: the 1.5-mile at-venue radius the page and the photo resolver already
 * auto-select within. Without that floor the rule would let the page auto-pick
 * an event 1 mile away while ignoring a second one 0.6 miles away — a 500 m
 * ambiguity check under a 1.5-mile auto-select is exactly the gap that bit.
 */

/** The radius inside which a snap is "at" a venue (page + photo resolver). */
export const SNAP_AT_VENUE_RADIUS_MILES = 1.5;
/** The ticket's floor for the ambiguity radius. */
export const SNAP_AMBIGUITY_MIN_METERS = 500;
/** Upper bound, so a coarse 20 km network fix cannot sweep a whole county. */
export const SNAP_AMBIGUITY_MAX_MILES = 10;
/** A picked fair is remembered this long (and only while the app stays open). */
export const SNAP_CHOICE_TTL_MS = 4 * 60 * 60 * 1000;

const METERS_PER_MILE = 1609.344;

/**
 * How the target event was chosen — sent by the page with every upload and
 * recorded on the inbound row's `capture_meta.event_choice_basis`.
 *
 *  - `picked`      the user tapped this fair (or it is their remembered pick)
 *  - `auto_single` exactly one candidate nearby; the page selected it
 *  - `server`      the user chose "Let the server decide" (no pin sent)
 *  - `auto_nearest_ambiguous` (server-side only) the upload was NOT picked and
 *    its location is near more than one same-day event: auto-write is held
 *
 * An upload from a page build older than this field carries none, and is
 * treated as NOT picked — the build that caused the incident must not be the
 * one the guard trusts.
 */
export type SnapEventChoiceBasis = "picked" | "auto_single" | "server" | "auto_nearest_ambiguous";

const CLIENT_BASES = new Set<string>(["picked", "auto_single", "server"]);

/** Narrow an untrusted client value; anything else (incl. absent) is null. */
export function parseSnapChoiceBasis(v: unknown): "picked" | "auto_single" | "server" | null {
  return typeof v === "string" && CLIENT_BASES.has(v)
    ? (v as "picked" | "auto_single" | "server")
    : null;
}

/** max(1.5 mi, 500 m, 2 × accuracy), capped at 10 mi. Accuracy in metres. */
export function snapAmbiguityRadiusMiles(accuracyM: number | null | undefined): number {
  const acc =
    typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : 0;
  const miles = Math.max(
    SNAP_AT_VENUE_RADIUS_MILES,
    SNAP_AMBIGUITY_MIN_METERS / METERS_PER_MILE,
    (2 * acc) / METERS_PER_MILE
  );
  return Math.min(miles, SNAP_AMBIGUITY_MAX_MILES);
}

export type SnapTarget<T> =
  { kind: "none" } | { kind: "single"; event: T } | { kind: "ambiguous"; candidates: T[] };

/**
 * Classify the nearby list. `distanceMiles` null (the location-free list) never
 * counts as a candidate. Distinct by `id`, so one event listed twice is one.
 */
export function classifySnapTarget<T extends { id: string; distanceMiles: number | null }>(
  nearby: readonly T[],
  accuracyM: number | null | undefined
): SnapTarget<T> {
  const r = snapAmbiguityRadiusMiles(accuracyM);
  const seen = new Set<string>();
  const candidates: T[] = [];
  for (const e of nearby) {
    if (e.distanceMiles === null || e.distanceMiles > r || seen.has(e.id)) continue;
    seen.add(e.id);
    candidates.push(e);
  }
  candidates.sort((a, b) => (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "single", event: candidates[0] };
  return { kind: "ambiguous", candidates };
}
