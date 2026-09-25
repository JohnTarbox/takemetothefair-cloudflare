/**
 * OPE-1159 — what one /admin/analytics card means, written from its query.
 *
 * A label is not a definition: the 2026-09-05 audit found "ERRORS 24h" counting
 * info and warn rows, a "Site CTR" built from a third of the traffic and a "last
 * 30 days" chart holding 27. Every entry here is written from the code that
 * computes the number, and names what it does NOT count, so a reader can tell
 * a real reading from a plausible one without opening the repo.
 */
export interface TileDefinition {
  /** One plain-English sentence: what the number is. */
  measures: string;
  /** Where it comes from — D1 table(s) or the external feed. */
  source: string;
  /** The window it covers and how fresh it is. */
  window: string;
  /** What it does not count, and anything that makes it read as something it isn't. */
  caveats?: string;
  /** What turns it amber/red, or sends it to the action queue — only if it colours itself. */
  thresholds?: string;
}
