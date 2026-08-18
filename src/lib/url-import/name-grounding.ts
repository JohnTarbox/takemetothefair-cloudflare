/**
 * OPE-378 — the extractor invented a word and put it in the event name.
 *
 * One unambiguous submission to submit@ produced an event called
 * **"28th Annual Holiday Craft Fair"**. The word *Holiday* appears nowhere in
 * the source:
 *
 *   "Waterville Elks Lodge #905 is currently seeking crafters for their annual
 *    craft fair on Sunday, November 1, 2026. … This is our 28th Annual event…"
 *
 * Everything else in that name is genuinely there. One token was added, it is
 * plausible for a November craft fair, and it changed what the event IS.
 *
 * This is OPE-432's date grounding applied to the other field a model is free
 * to embellish. Dates at least look wrong when they are wrong; an invented name
 * reads perfectly, which is why it survived to a public record and was caught
 * only because submissions land PENDING.
 *
 * ── Flag, don't rewrite ──────────────────────────────────────────────────
 *
 * The ticket offers "constrain name generation to source tokens (or flag any
 * added token for review)". Flagging is the safer half and the one implemented:
 * a name is a human-facing string, and silently deleting a word from it can
 * easily produce something worse than the embellishment ("Holiday Craft Fair"
 * → "Craft Fair" is fine; "St. Patrick's Day Parade" minus an ungrounded token
 * is not). Detection routes it to the review queue that already exists.
 *
 * ── What counts as grounded ──────────────────────────────────────────────
 *
 * A token is grounded when it appears anywhere in the source — body, subject or
 * fetched page. Deliberately generous:
 *
 *   - Word-level, not phrase-level. The extractor legitimately reorders and
 *     recombines ("Waterville Elks Lodge #905 28th Annual Craft Fair" is a
 *     perfectly good name assembled from scattered source words).
 *   - Stopwords and connectors are ignored — "the", "of", "and" carry no claim.
 *   - A 4-digit year is exempt: we append the edition year by convention, and
 *     it is verified separately by OPE-432's date grounding.
 *   - Prefix matching on stems, so "crafters" in the source grounds "craft" in
 *     the name. Plural/singular drift is not a fabrication.
 *
 * The point is to catch a token carrying NEW MEANING, not to police wording.
 */

/** Words that carry no factual claim and are never worth flagging. */
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
  "its",
  "their",
  "our",
  "this",
  "that",
  "is",
  "are",
  "be",
  "new",
  "annual",
  "event",
  "events",
  "presents",
  "featuring",
  "inc",
  "llc",
  "co",
]);

/** Shortest token worth checking — below this, matching is noise. */
const MIN_TOKEN = 3;

/**
 * Split on anything that is not a letter or digit, Unicode-aware.
 *
 * `\p{L}` rather than an ASCII class on purpose: New England place names carry
 * accents (Coös County, Château-Richer in the Québec-adjacent listings), and an
 * ASCII split would shatter them into fragments that ground against nothing —
 * turning a correctly-extracted name into a fabrication report. It also keeps
 * this clear of the #120 lint, which bans inline `[^a-z0-9]+` chains precisely
 * because they mangle exactly these characters.
 */
function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Is `token` present in the source token set, allowing stem prefixes? */
function grounded(token: string, sourceTokens: ReadonlySet<string>): boolean {
  if (sourceTokens.has(token)) return true;
  // Stem tolerance both ways: "crafters" grounds "craft", "craft" grounds
  // "crafts". Requires a real prefix overlap, not a 1-2 char coincidence.
  for (const s of sourceTokens) {
    if (s.length >= MIN_TOKEN && token.length >= MIN_TOKEN) {
      if (s.startsWith(token) || token.startsWith(s)) return true;
    }
  }
  return false;
}

export interface NameGroundingResult {
  /** Name tokens carrying meaning that do not appear in the source. */
  ungroundedTokens: string[];
  /** True when the name should be routed to human review. */
  shouldFlag: boolean;
  /** Human-readable reason, for the review queue and telemetry. */
  reason: string | null;
}

/**
 * Check an extracted event name against everything we read.
 *
 * `sources` is every text we saw — body, subject, fetched page, OCR'd
 * attachment. Passing them all matters: a name legitimately drawn from a flyer
 * would otherwise look invented.
 */
export function groundNameInSources(
  name: string | null | undefined,
  sources: ReadonlyArray<string | null | undefined>
): NameGroundingResult {
  if (!name || !name.trim()) {
    return { ungroundedTokens: [], shouldFlag: false, reason: null };
  }
  const sourceText = sources.filter(Boolean).join(" ");
  // No source to check against proves nothing — a fetch failure must not become
  // an accusation. Same fail-safe as OPE-432's date grounding.
  if (!sourceText.trim()) {
    return { ungroundedTokens: [], shouldFlag: false, reason: null };
  }

  const sourceTokens = new Set(tokenize(sourceText));
  const ungrounded = tokenize(name).filter((t) => {
    if (t.length < MIN_TOKEN) return false;
    if (STOPWORDS.has(t)) return false;
    if (/^\d{4}$/.test(t)) return false; // edition year — we add it on purpose
    if (/^\d+(st|nd|rd|th)$/.test(t)) return false; // 28th, 3rd — ordinals
    return !grounded(t, sourceTokens);
  });

  if (ungrounded.length === 0) {
    return { ungroundedTokens: [], shouldFlag: false, reason: null };
  }
  return {
    ungroundedTokens: ungrounded,
    shouldFlag: true,
    reason:
      `event name contains ${ungrounded.length} token(s) absent from every source: ` +
      ungrounded.join(", "),
  };
}
