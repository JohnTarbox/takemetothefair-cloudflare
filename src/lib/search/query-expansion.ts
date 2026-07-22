/**
 * OPE-281 — internal-search query expansion.
 *
 * The `/api/search` box did a bare `LOWER(events.name) LIKE %q%`, so queries
 * whose events plainly exist returned zero results (VoC audit OPE-274):
 *   - "arts and crafts fair"  → the whole Craft Fair / Art Show CATEGORY was
 *                               invisible to a name query
 *   - "holiday fair salem ma" → "fair" never treated as a SYNONYM of market
 *   - "blueberry connecticut" → a TERM couldn't be combined with a LOCATION
 *   - "mrshfeild"             → a common MISSPELLING of Marshfield matched nothing
 *
 * This module turns a raw query into structured match intent — name-term groups
 * (with event-type synonyms), mapped category names, and a trailing state — that
 * the route compiles into SQL. The fuzzy-misspelling leg is handled separately
 * in the route as a zero-result fallback (it needs the DB), keeping this module
 * pure and unit-testable.
 */
import { STATES, STATE_CODES, isStateCode, type StateCode } from "@/lib/states";

/** Event-type nouns that are interchangeable in a fair-goer's query. */
export const EVENT_TYPE_SYNONYMS = [
  "fair",
  "faire",
  "market",
  "festival",
  "fest",
  "show",
  "expo",
  "exposition",
  "celebration",
];
const EVENT_TYPE_SET = new Set(EVENT_TYPE_SYNONYMS);

/** Phrases that should also match by CATEGORY, not just literal name text. */
const CATEGORY_PHRASE_MAP: { pattern: RegExp; categories: string[] }[] = [
  {
    pattern: /\barts?\s*(?:and|&|'?n'?)\s*crafts?\b/,
    categories: ["Craft Fair", "Craft Show", "Art Fair", "Art Show"],
  },
  { pattern: /\bcrafts?\b/, categories: ["Craft Fair", "Craft Show", "Makers Market"] },
  { pattern: /\bart\b/, categories: ["Art Fair", "Art Show", "Art Walk"] },
  { pattern: /\bfarmers?\b/, categories: ["Farmers Market"] },
  { pattern: /\bflea\b/, categories: ["Flea Market"] },
  { pattern: /\bantiques?\b/, categories: ["Antique Show"] },
  { pattern: /\b(?:cars?|auto)\b/, categories: ["Car Show"] },
  { pattern: /\bboats?\b/, categories: ["Boat Show"] },
  { pattern: /\bgardens?\b/, categories: ["Garden Show"] },
  { pattern: /\bhome\b/, categories: ["Home Show"] },
  { pattern: /\bgun\b/, categories: ["Gun Show"] },
  { pattern: /\b(?:music|concert)\b/, categories: ["Music Festival"] },
  { pattern: /\b(?:beer|brew)\b/, categories: ["Beer Festival"] },
  { pattern: /\bfood\b/, categories: ["Food Festival"] },
  { pattern: /\bharvest\b/, categories: ["Harvest Festival"] },
  { pattern: /\bballoons?\b/, categories: ["Balloon Festival"] },
];

/** Tokens with no discriminating value in a search. */
const STOPWORDS = new Set(["and", "the", "a", "an", "of", "for", "in", "at", "on", "&", "n", "to"]);

/** name/slug/code → StateCode (e.g. "connecticut" → "CT", "ma" → "MA"). */
const STATE_BY_NAME: Record<string, StateCode> = {};
for (const code of STATE_CODES) {
  STATE_BY_NAME[STATES[code].name.toLowerCase()] = code;
  STATE_BY_NAME[STATES[code].slug.replace(/-/g, " ")] = code;
}

export interface ExpandedQuery {
  /** Original, lowercased/trimmed. */
  raw: string;
  /** Trailing state token, stripped from the terms. Null when none. */
  stateCode: StateCode | null;
  /**
   * AND-ed groups of OR-alternatives to match against events.name. A group with
   * an event-type synonym expands to all its synonyms (fair→[fair,market,…]).
   */
  nameTermGroups: string[][];
  /** Category names to match against the events.categories JSON. */
  categoryNames: string[];
  /**
   * Distinctive query tokens (no stopwords, no event-type synonyms, no state) —
   * the words that carry the query's meaning. Used by the route's zero-result
   * fuzzy fallback so a misspelling like "mrshfeild" can match "Marshfield".
   */
  coreTerms: string[];
}

/**
 * Detect a trailing US-state token (2-letter code, or a 1–2 word state name like
 * "connecticut" / "new hampshire"). Returns the code + how many tokens it ate.
 */
function matchTrailingState(tokens: string[]): { code: StateCode | null; consumed: number } {
  if (tokens.length === 0) return { code: null, consumed: 0 };
  const last = tokens[tokens.length - 1];
  // Two-word state name ("new hampshire", "rhode island").
  if (tokens.length >= 2) {
    const twoWord = `${tokens[tokens.length - 2]} ${last}`;
    if (STATE_BY_NAME[twoWord]) return { code: STATE_BY_NAME[twoWord], consumed: 2 };
  }
  if (STATE_BY_NAME[last]) return { code: STATE_BY_NAME[last], consumed: 1 };
  // 2-letter code — only when it's not the whole query (avoid a lone "ma").
  if (last.length === 2 && isStateCode(last.toUpperCase()) && tokens.length >= 2) {
    return { code: last.toUpperCase() as StateCode, consumed: 1 };
  }
  return { code: null, consumed: 0 };
}

/**
 * Expand a raw search query into structured match intent. Pure — no DB access.
 */
export function expandEventSearchQuery(query: string): ExpandedQuery {
  const raw = query.trim().toLowerCase();
  let tokens = raw.split(/\s+/).filter(Boolean);

  const { code: stateCode, consumed } = matchTrailingState(tokens);
  if (consumed > 0) tokens = tokens.slice(0, tokens.length - consumed);

  const remainingText = tokens.join(" ");
  const categoryNames: string[] = [];
  for (const { pattern, categories } of CATEGORY_PHRASE_MAP) {
    if (pattern.test(remainingText)) {
      for (const c of categories) if (!categoryNames.includes(c)) categoryNames.push(c);
    }
  }

  const nameTermGroups: string[][] = [];
  const coreTerms: string[] = [];
  for (const tok of tokens) {
    if (STOPWORDS.has(tok)) continue;
    if (EVENT_TYPE_SET.has(tok)) {
      nameTermGroups.push([...EVENT_TYPE_SYNONYMS]);
    } else {
      nameTermGroups.push([tok]);
      coreTerms.push(tok);
    }
  }

  return { raw, stateCode, nameTermGroups, categoryNames, coreTerms };
}
