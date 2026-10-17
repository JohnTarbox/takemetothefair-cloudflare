/**
 * OPE-1484 — find what an organizer's page SAYS about parking, accessibility
 * and pets, as verbatim sentences.
 *
 * Deterministic on purpose. The excerpt is a sentence cut from the page text,
 * so it is verbatim by construction — the evidence rule on
 * `events.parking_notes` / `accessibility_notes` / `pet_friendly` (OPE-1061,
 * OPE-1481) can never be met by a paraphrase the model wrote. It also keeps
 * the shared AI extraction prompt (the CRITICAL URL importer) untouched.
 *
 * Output is a PROPOSAL input only: nothing here writes a field. And it never
 * infers — a page with no pet sentence, or one whose pet sentence states no
 * clear rule, yields `pets: null` (UNSET), never NO.
 */

export interface VisitorFactExcerpt {
  excerpt: string;
}
export interface PetFactExcerpt extends VisitorFactExcerpt {
  /** Only a sentence that states YES or NO is returned at all. */
  value: "YES" | "NO";
}
export interface VisitorFacts {
  parking: VisitorFactExcerpt | null;
  accessibility: VisitorFactExcerpt | null;
  pets: PetFactExcerpt | null;
}

/** The public column cap (OPE-1481): a longer sentence is not a usable note. */
export const VISITOR_FACT_MAX = 300;
const MIN_LEN = 12;
/** Nav labels and headings ("Parking Authority", "Accessibility") are not statements. */
const MIN_WORDS = 5;
/** The event's own LOCATION in a lot is not visitor parking guidance. */
const LOCATED_IN_LOT =
  /\b(?:located|held|takes place|set up|hosted)\b[^.]{0,40}\bparking (?:lot|garage|area)\b/i;

const PARKING = /\bparking\b|\bshuttles?\b|\bpark(?:ed)? (?:in|at|on) the\b/i;
// A parking sentence must GUIDE a visitor (cost, availability, where), not
// merely mention parking ("easy navigation, parking, and crowd control").
const PARKING_GUIDE =
  /\b(?:free|paid|limited|available|ample|overflow|accessible|handicap)\b[^.]{0,30}\bparking\b|\bparking\b[^.]{0,40}\b(?:is|are|will be)\b|\bparking (?:lots?|areas?|garages?|fees?)\b|\bshuttles?\b|\bpark (?:in|at|on|across|behind)\b/i;
// Parking for vendors / trailers / campers is not the visitor's answer, and a
// row of an admission-price table is not a parking statement.
const NOT_VISITOR_PARKING =
  /\b(?:vendors?|exhibitors?|trailers?|camping|campers?|RVs?|staff)\b|\bseniors?\b|\b65 ?(?:&|and|\+)|\bmilitary\b|\bchildren\b/i;
// "accessible" alone matches "accessible by car / from I-95"; require a
// mobility word or an accessible FACILITY.
const ACCESSIBILITY =
  /\bwheel ?chairs?\b|\bhandicap(?:ped)?\b|\bADA\b|\bmobility\b|\baccessible (?:restrooms?|bathrooms?|entrances?|parking|seating|paths?|ramps?)\b|\b(?:fully|handicap|wheelchair)[- ]accessible\b/i;
const PET_WORD = /\b(?:pets?|dogs?|service animals?)\b/i;
const SERVICE_ANIMAL = /\bservice (?:dogs?|animals?)\b/i;
// A pet sentence must state a RULE, not merely mention an animal ("dog show",
// "hot dogs", "4-H dog agility").
const PET_RULE =
  /\b(?:allowed|permitted|welcome|prohibited|leash(?:ed)?|forbidden|not allowed|no pets|no dogs|service animals?|pet[- ]friendly|dog[- ]friendly)\b/i;
const FOOD_DOG = /\b(?:hot|corn|chili)[- ]dogs?\b/gi;

const PET_NO =
  /\bno (?:pets|dogs)\b|\b(?:pets|dogs)\b[^.]{0,40}\b(?:not|aren't|are not|n't) (?:be )?(?:allowed|permitted)\b|\b(?:pets|dogs)\b[^.]{0,30}\b(?:prohibited|forbidden)\b|\bservice (?:animals?|dogs?) only\b|\bonly\b[^.]{0,40}\bservice (?:animals?|dogs?)\b|\bexception of service (?:animals?|dogs?)\b|\bexcept(?:ing)? (?:for )?service (?:animals?|dogs?)\b/i;
const PET_YES =
  /\b(?:pets|dogs)\b[^.]{0,40}\b(?:are |is )?(?:welcome|allowed|permitted)\b|\bleashed (?:pets|dogs)\b|\b(?:pet|dog)[- ]friendly\b/i;

/** Sentences and list items, whitespace-normalised. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|\s*•\s*|\s+\|\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= MIN_LEN && s.length <= VISITOR_FACT_MAX);
}

/** A sentence that can stand as the organizer's statement: long enough to say
 *  something, and not a question ("Where can I park?" — its answer may be). */
function isStatement(sentence: string): boolean {
  return !sentence.endsWith("?") && sentence.split(" ").length >= MIN_WORDS;
}

export function classifyPetSentence(sentence: string): "YES" | "NO" | null {
  const s = sentence.replace(FOOD_DOG, "");
  if (PET_NO.test(s)) return "NO";
  if (PET_YES.test(s)) return "YES";
  return null;
}

/**
 * The first sentence per topic. One sentence, not a stitched paragraph: a
 * reviewer compares it to the page, and a stitched excerpt is not verbatim.
 */
export function findVisitorFacts(text: string | null | undefined): VisitorFacts {
  const out: VisitorFacts = { parking: null, accessibility: null, pets: null };
  if (!text) return out;
  for (const sentence of splitSentences(text)) {
    if (!isStatement(sentence)) continue;
    // An ADA sentence about service animals is the pet rule, not access.
    if (!out.accessibility && ACCESSIBILITY.test(sentence) && !SERVICE_ANIMAL.test(sentence)) {
      out.accessibility = { excerpt: sentence };
    }
    if (
      !out.parking &&
      PARKING.test(sentence) &&
      PARKING_GUIDE.test(sentence) &&
      !LOCATED_IN_LOT.test(sentence) &&
      !NOT_VISITOR_PARKING.test(sentence)
    ) {
      out.parking = { excerpt: sentence };
    }
    if (!out.pets) {
      const s = sentence.replace(FOOD_DOG, "");
      // Staged only when the sentence STATES a rule we can classify; a pet
      // mention with no clear rule ("Service Animal Policy") stays UNSET.
      const value = PET_WORD.test(s) && PET_RULE.test(s) ? classifyPetSentence(sentence) : null;
      if (value) out.pets = { excerpt: sentence, value };
    }
    if (out.parking && out.accessibility && out.pets) break;
  }
  return out;
}

/**
 * Attach `visitorFacts` to a ONE-event extraction. A multi-event page (a
 * calendar, a venue's season) cannot attribute "no pets on the grounds" to
 * any single event, so nothing is attached there — absent, not guessed.
 */
export function withVisitorFacts<T extends object>(
  events: T[],
  text: string | null | undefined
): Array<T & { visitorFacts?: VisitorFacts }> {
  if (events.length !== 1) return events;
  const facts = findVisitorFacts(text);
  if (!facts.parking && !facts.accessibility && !facts.pets) return events;
  return [{ ...events[0], visitorFacts: facts }];
}
