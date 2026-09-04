/**
 * OPE-794 — read a vendor-capacity claim out of organizer copy.
 *
 * The phrases are formulaic, which is the only reason this is worth doing
 * deterministically rather than asking a model:
 *
 *   "We are full for 2026, anyone on our waitlist is to be notified if any
 *    spaces become available."          — ogunquit.org/annual-craft-fairs
 *   "first floor sold out, second floor tables still available"
 *                                       — Manchester Grange, 2026-08-27
 *
 * ## What this deliberately will NOT do
 *
 * It returns `null` — not `OPEN` — when it recognises nothing. `OPEN` is a
 * positive claim that a vendor can still apply, and inferring it from the
 * ABSENCE of the word "full" would manufacture exactly the assertion OPE-433
 * warns about: a confidence value nobody checked. Silence means `UNKNOWN`, and
 * the caller leaves the column alone.
 *
 * ## Order of precedence
 *
 * A page that says BOTH "we are full" and "spaces still available" is
 * describing partial capacity, not contradicting itself, and the two specimens
 * above are one of each. The closed reading wins the enum and the open phrase
 * survives in the note, because telling a vendor a full show is open costs them
 * a wasted application, while the reverse costs them nothing they can measure.
 */
import type { VendorCapacityStatus } from "@takemetothefair/constants";

// Lives in the shared package, not the app, because the MCP admin reader is the
// first real caller: it classifies an event's own prose so an operator can see
// "this copy says FULL" before any writer for the column exists (OPE-709 hazard
// 4 — the reader lands before the writer, deliberately).

export interface VendorCapacityReading {
  status: VendorCapacityStatus;
  /** The sentence the reading came from, trimmed — evidence, not decoration. */
  evidence: string;
}

/** Phrases in strength order. First match on the strongest tier wins. */
const WAITLIST_PATTERNS = [/\bwait[\s-]?list(ed|ing)?\b/i];

const FULL_PATTERNS = [
  /\bwe(?:'re| are)\s+full\b/i,
  /\bcurrently\s+full\b/i,
  /\bfully\s+booked\b/i,
  /\bsold\s+out\b/i,
  /\bat\s+capacity\b/i,
  /\bno\s+(?:more\s+)?(?:spaces?|spots?|booths?|tables?)\s+(?:are\s+)?available\b/i,
];

const CLOSED_PATTERNS = [
  /\bapplications?\s+(?:are\s+)?closed\b/i,
  /\bregistration\s+(?:is\s+)?closed\b/i,
  /\bno\s+longer\s+accepting\s+(?:applications?|vendors?|exhibitors?)\b/i,
  /\bnot\s+accepting\s+(?:applications?|vendors?|exhibitors?)\b/i,
];

const OPEN_PATTERNS = [
  /\b(?:spaces?|spots?|booths?|tables?)\s+(?:are\s+)?(?:still\s+)?available\b/i,
  /\bstill\s+accepting\s+(?:applications?|vendors?|exhibitors?)\b/i,
  /\bnow\s+accepting\s+(?:applications?|vendors?|exhibitors?)\b/i,
  /\bapplications?\s+(?:are\s+)?open\b/i,
  /\bvendor\s+applications?\s+(?:are\s+)?(?:now\s+)?open\b/i,
];

/** Split into sentence-ish chunks so the evidence names the phrase, not the page. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstMatch(chunks: string[], patterns: RegExp[]): string | null {
  for (const chunk of chunks) {
    if (patterns.some((p) => p.test(chunk))) return chunk;
  }
  return null;
}

/**
 * Classify organizer copy, or return `null` when nothing is recognised.
 *
 * `null` is the important return. It means "no evidence", which the caller
 * stores as `UNKNOWN` — it does NOT mean open.
 */
export function classifyVendorCapacity(
  text: string | null | undefined
): VendorCapacityReading | null {
  if (!text || !text.trim()) return null;
  const chunks = sentences(text);

  // WAITLIST outranks FULL: "we are full, anyone on our waitlist is notified"
  // is a waitlist, and calling it FULL would discard the one actionable fact in
  // the sentence — that there is still something a vendor can do.
  const waitlist = firstMatch(chunks, WAITLIST_PATTERNS);
  if (waitlist) return { status: "WAITLIST", evidence: waitlist };

  const closed = firstMatch(chunks, CLOSED_PATTERNS);
  if (closed) return { status: "CLOSED", evidence: closed };

  const full = firstMatch(chunks, FULL_PATTERNS);
  if (full) return { status: "FULL", evidence: full };

  const open = firstMatch(chunks, OPEN_PATTERNS);
  if (open) return { status: "OPEN", evidence: open };

  return null;
}
