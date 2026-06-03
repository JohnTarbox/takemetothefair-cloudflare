/**
 * K12 / GW1 relevance classifier — "is this discovered event worth
 * surfacing for vendor consumption?"
 *
 * K12 part 3 (analyst, 2026-06-02). The Lupine Festival audit on 6/2
 * watched the operator manually crawl `historicrangeley.org/events` and
 * triage the results — 3 of ~13 items were vendor-relevant (Lupine
 * Festival, Oquossoc Day, Fall Festival); the rest were lectures,
 * workshops, museum talks, meetings. **Capturing that triage rule as
 * code is K12's net-new model surface.** Everything else in K12
 * (domain-tier gate, discovery_candidates enqueue, dedup pass) is
 * existing infrastructure.
 *
 * ## Design choice
 *
 * Start with a simple keyword/regex rule set scored against a hand-
 * labeled sample (per the dev-email spec). Can be upgraded to a small
 * classifier later if accuracy is insufficient. The hand-labeled
 * sample lives in the unit tests so the rule set evolves with regression
 * coverage.
 *
 * ## Rule shape
 *
 * - **Negative patterns short-circuit to false.** "Lecture", "workshop",
 *   "class", "meeting", "gala", "auction", "benefit", "service" mean
 *   the event isn't a vendor-floor event regardless of any positive
 *   signal in the name. Asymmetric weighting is intentional — a false
 *   negative (good event we miss) costs at most one operator-tag away;
 *   a false positive (museum lecture entering the public event surface)
 *   degrades the site's relevance signal for the affected vendor pages.
 *
 * - **Positive patterns admit.** Craft fair, farmers market, festival,
 *   home show, trade show, expo, antique show, flea market. These are
 *   the high-confidence patterns observed in the Maine corpus.
 *
 * - **Default: not relevant.** Without a positive signal, conservative:
 *   keep it out of the harvest queue. K12 is feeding a PENDING-review
 *   bucket either way — operators can hand-promote anything the
 *   classifier misses.
 *
 * ## Out of scope
 *
 * - Source-of-truth signal (the event's category from `categories[]`)
 *   isn't passed in here — the K7 deterministic salvage path doesn't
 *   reliably populate categories, and this classifier runs in
 *   discovery (pre-ingest). When `categories` is reliable downstream,
 *   it's stronger than name keywords; for now name is what we have.
 *
 * - Locale: patterns are English-only. The 2026 corpus is 100% English
 *   so the simplification is safe.
 */

const NEGATIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\blecture[s]?\b/i,
  /\bworkshop[s]?\b/i,
  /\bclass(?:es)?\b/i,
  /\bmeeting[s]?\b/i,
  /\bgala\b/i,
  /\bbenefit\b/i,
  /\bauction\b/i,
  /\badmission\s+day\b/i,
  /\bservice[s]?\b/i, // religious / town services
  /\bwebinar\b/i,
  /\bseminar[s]?\b/i,
  /\bbook\s+(?:club|signing|launch|reading)\b/i,
  /\b(?:annual|business)\s+meeting\b/i,
  /\btown\s+hall\b/i,
  /\bopen\s+mic\b/i,
  /\bfundraiser\b/i,
];

const POSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  // "craft" + (fair|show|expo|market). "Holiday Craft Market" was the
  // miss that surfaced this — see __tests__/goodwill-relevance.test.ts.
  /\bcraft\s+(?:fair|show|expo|market)\b/i,
  /\bfarmers?\s+market\b/i,
  /\bfestival\b/i,
  /\bhome\s+show\b/i,
  /\btrade\s+show\b/i,
  /\b(?:agricultural|county|state)\s+fair\b/i,
  /\b(?:flea|holiday)\s+market\b/i,
  /\bantique\s+(?:show|fair|expo)\b/i,
  /\bcar\s+show\b/i,
  /\bexpo\b/i,
  /\b(?:fall|spring|summer|winter|holiday)\s+(?:fair|market|festival|show)\b/i,
  /\b(?:vendor|art|fine\s+art|fine\s+craft)\s+(?:fair|show|market)\b/i,
];

/**
 * Decide whether a discovered event name (optionally paired with a
 * stored category) is worth queuing as a vendor-floor candidate.
 *
 * Returns `true` ⇒ enqueue; `false` ⇒ skip.
 *
 * Both fields are checked; either matching a positive pattern with no
 * matching negative pattern admits.
 */
export function isVendorRelevantEvent(name: string, category?: string | null): boolean {
  const haystack = `${name} ${category ?? ""}`.trim();
  if (haystack.length === 0) return false;

  // Negative short-circuit.
  if (NEGATIVE_PATTERNS.some((p) => p.test(haystack))) return false;

  // Positive admit.
  if (POSITIVE_PATTERNS.some((p) => p.test(haystack))) return true;

  // Default: not relevant. Conservative.
  return false;
}

/**
 * Exported for unit tests + GW1e report-card. Lets the test sample
 * cite which rule fired and lets the report-card surface the rule
 * distribution over time.
 */
export function classifyRelevance(
  name: string,
  category?: string | null
): { relevant: boolean; matchedRule: string | null } {
  const haystack = `${name} ${category ?? ""}`.trim();
  if (haystack.length === 0) return { relevant: false, matchedRule: null };

  for (const p of NEGATIVE_PATTERNS) {
    if (p.test(haystack)) return { relevant: false, matchedRule: `neg:${p.source}` };
  }
  for (const p of POSITIVE_PATTERNS) {
    if (p.test(haystack)) return { relevant: true, matchedRule: `pos:${p.source}` };
  }
  return { relevant: false, matchedRule: null };
}
