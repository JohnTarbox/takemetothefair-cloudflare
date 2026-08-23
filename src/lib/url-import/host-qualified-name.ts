/**
 * OPE-378 defect 4 — the organizer's name never reached the event's name.
 *
 * The Waterville specimen produced two records both called some variant of
 * "28th Annual Craft Fair". That name is true, and it is useless: it identifies
 * no fair in particular, collides with every other craft fair in the state, and
 * gives a reader nothing to recognise. The source said who was running it in its
 * very first clause — "Waterville Elks Lodge #905 is currently seeking
 * crafters" — and the extractor dropped it.
 *
 * ── Why a CONVENTION and not a model call ────────────────────────────────
 *
 * The earlier push-back on this defect was right: asking the extractor to write
 * a better name is name synthesis, and name synthesis is precisely what produced
 * the invented "Holiday" in defect 2 of this same ticket. So this is a rule, not
 * a judgement:
 *
 *   IF every meaning-bearing token of the name is a generic fair word
 *   AND the submission carries a host/venue name that is itself specific
 *   AND that host is not already in the name
 *   THEN prefix the host, verbatim, and keep the original name intact.
 *
 * ── Why prefixing is safe where deleting was not ─────────────────────────
 *
 * `name-grounding.ts` deliberately flags rather than rewrites, because removing
 * a token from a human-facing string can produce something worse than the
 * embellishment. Prefixing does not have that hazard and is not the same
 * operation: nothing is removed, every added token comes from the submission
 * itself (so the grounding gate still passes by construction), and the result is
 * strictly more specific than the input. This can make a name longer or
 * redundant; it cannot make it false.
 *
 * ── The generic-word list, and why the HOST is tested against it too ─────
 *
 * A host of "Fairgrounds" would turn "Craft Fair" into "Fairgrounds Craft Fair"
 * — more words, no more information. So the host must contribute at least one
 * token that is NOT generic. That single check is what keeps the rule from
 * firing on the cases where it would add noise.
 */

/** Words that appear in a fair's name without identifying WHICH fair. */
const GENERIC_EVENT_WORDS = new Set([
  "annual",
  "art",
  "arts",
  "bazaar",
  "boutique",
  "carnival",
  "celebration",
  "craft",
  "crafts",
  "crafters",
  "expo",
  "exposition",
  "fair",
  "fairs",
  "fest",
  "festival",
  "festivals",
  "flea",
  "gathering",
  "market",
  "markets",
  "sale",
  "show",
  "showcase",
  "days",
  "day",
  "weekend",
  // Seasonal / occasion qualifiers. Present in real names, but never the thing
  // that tells two fairs apart.
  "autumn",
  "christmas",
  "fall",
  "holiday",
  "spring",
  "summer",
  "winter",
  "vendor",
  "vendors",
  "antique",
  "antiques",
  "farmers",
  "farmer",
  "flower",
  "food",
  "harvest",
  "vintage",
  // Place words. A host is only worth prefixing if it names a PARTICULAR
  // place; "The Fairgrounds" or "Community Center" does not. Real fairs keep
  // their anchor through this — "Common Ground Country Fair" still has
  // "country", "Grange Hall" still has "grange".
  "fairgrounds",
  "grounds",
  "hall",
  "center",
  "centre",
  "complex",
  "arena",
  "pavilion",
  "park",
  "common",
  "commons",
  "green",
  "field",
  "fields",
  "community",
  "club",
  "association",
  "society",
  "committee",
]);

/** Connectors that carry no claim either way. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "at",
  "in",
  "on",
  "for",
  "to",
  "with",
  "by",
  "from",
  "our",
  "its",
  "their",
]);

/** `28th`, `3rd`, `1st` — an ordinal counts the edition, not the fair. */
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;
/** A 4-digit edition year, appended by convention elsewhere. */
const YEAR = /^(?:19|20)\d{2}$/;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9#\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Tokens that could distinguish this fair from another one. */
function meaningfulTokens(s: string): string[] {
  return tokens(s).filter(
    (t) =>
      !STOPWORDS.has(t) &&
      !GENERIC_EVENT_WORDS.has(t) &&
      !ORDINAL.test(t) &&
      !YEAR.test(t) &&
      // A bare edition number ("28 Annual") counts as an ordinal too.
      !/^\d+$/.test(t)
  );
}

/**
 * True when a name says what KIND of event this is but not WHICH one.
 *
 * "28th Annual Craft Fair" → true. "Fryeburg Fair" → false ("fryeburg"
 * survives). "Waterville Elks Lodge #905 Craft Fair" → false.
 */
export function isGenericEventName(name: string): boolean {
  const t = tokens(name);
  // An empty or punctuation-only name is a different problem
  // (`isUnusableEventName` handles it); do not claim it here.
  if (t.length === 0) return false;
  return meaningfulTokens(name).length === 0;
}

export interface HostQualifyResult {
  /** The name to use — unchanged when the rule does not apply. */
  name: string;
  /** True when the host was prefixed. */
  applied: boolean;
  /** Why not, when it wasn't. Present so a no-op is never silent.
   *
   *  There is deliberately no "host-already-in-name": that state cannot occur.
   *  A name containing the host's distinguishing tokens is not generic, so it
   *  exits at `name-is-specific` first. A branch for it was written and removed
   *  when a test proved it unreachable — a guard that can never fire reads as
   *  protection that is not there. */
  reason?: "name-is-specific" | "no-host" | "host-is-generic" | "too-long";
}

/** Longest name we will produce. `nameSchema` caps at 200; stop short of it so
 *  a later year suffix cannot push a qualified name over the limit. */
const MAX_QUALIFIED_NAME = 180;

/**
 * Apply the host-in-name convention.
 *
 * Deterministic and total: same inputs, same output, and every path that
 * declines says which one it took.
 */
export function qualifyNameWithHost(
  name: string,
  hostName: string | null | undefined
): HostQualifyResult {
  if (!isGenericEventName(name)) return { name, applied: false, reason: "name-is-specific" };

  const host = (hostName ?? "").trim();
  if (!host) return { name, applied: false, reason: "no-host" };

  // A host that is itself only generic words adds length, not information.
  if (meaningfulTokens(host).length === 0)
    return { name, applied: false, reason: "host-is-generic" };

  const qualified = `${host} ${name.trim()}`;
  if (qualified.length > MAX_QUALIFIED_NAME) return { name, applied: false, reason: "too-long" };

  return { name: qualified, applied: true };
}
