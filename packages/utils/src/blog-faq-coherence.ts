/**
 * OPE-280 — blog FAQ coherence detector.
 *
 * `update_blog_post` accepts `faqs` (the JSON column that drives FAQPage JSON-LD)
 * and `body` (the rendered markdown) as independent fields with nothing
 * reconciling them. When a later edit lands only in the column, the post
 * disagrees with itself — the corrected column emits as structured data to
 * search engines while the stale body is what a human reader sees. The defect is
 * invisible to anyone validating the post's schema, precisely when the page is
 * wrong.
 *
 * This is DETECTION, not enforcement (per the ticket): a body and an FAQ
 * legitimately differ in wording. The signal worth having is *contradiction*,
 * not *divergence* — so we compare only ANCHORED, typed numeric claims (a route
 * length in miles, an attendance count, a dollar price) between the body's
 * `## Q:` FAQ blocks and the column's answers, and flag a type only when the two
 * sides assert wholly disjoint values for it.
 *
 * Deliberately narrow to keep precision high:
 *  - Clock times are NOT compared. The canonical example ("10–11 a.m." in the
 *    body vs "10:30 AM" in the column) is a range-vs-point that is not actually a
 *    contradiction; times produce more noise than signal.
 *  - Numbers are matched only in a unit/entity context (miles, attendees, $),
 *    never bare, so a stray figure in prose can't trip the flag.
 *  - A type fires only when body and column values are fully DISJOINT — a shared
 *    value (the two agree somewhere) suppresses it.
 */

export type FaqConflictType =
  | "distance_miles"
  | "attendance_count"
  | "price_usd"
  | "admission_free_vs_paid"
  | "venue_all_events";

export interface FaqCoherenceConflict {
  type: FaqConflictType;
  /** Numbers for the numeric types (free admission is 0); place names for `venue_all_events`. */
  bodyValues: Array<number | string>;
  columnValues: Array<number | string>;
}

export interface FaqCoherenceResult {
  /** True when the body FAQ blocks and the column make a conflicting typed claim. */
  incoherent: boolean;
  conflicts: FaqCoherenceConflict[];
}

/** Concatenated question+answer text of the column `faqs` JSON, or "" if absent/invalid. */
function columnFaqText(faqsJson: string | null | undefined): string {
  if (!faqsJson) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(faqsJson);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  return parsed
    .map((it) => {
      if (!it || typeof it !== "object") return "";
      const q = (it as { question?: unknown }).question;
      const a = (it as { answer?: unknown }).answer;
      return `${typeof q === "string" ? q : ""} ${typeof a === "string" ? a : ""}`;
    })
    .join("\n");
}

/**
 * Text of the body's FAQ blocks.
 *
 * ── OPE-280 rework: why this got wider ──────────────────────────────────
 *
 * The original captured `## Q:` headings only, mirroring the Tier-2 extraction
 * the public page uses. That was a defensible choice and it made the detector
 * useless: swept across all 100 published posts on 2026-08-18 it returned
 * `incoherent: false` on 100 of 100, including both specimens this ticket was
 * filed for.
 *
 * The cause is one fact, and it explains the whole 0% rate rather than two
 * separate misses: **neither specimen contains a single `## Q:` heading.** Both
 * write their FAQs as bold questions —
 *
 *     **What's the biggest fair in Maine?**
 *     The Fryeburg Fair is Maine's largest … drawing 300,000+ visitors …
 *
 * — so `bodyFaqText` returned "" and the comparison short-circuited before any
 * rule ran. It was not a rule bug. There was nothing on the body side to apply
 * a rule to.
 *
 * Both forms are now captured. A block ends at the next heading of either form,
 * which is what the `## Q:` path already did.
 */
function bodyFaqText(body: string | null | undefined): string {
  if (!body) return "";
  const out: string[] = [];
  let inFence = false;
  let capturing = false;
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+Q\s*:\s*.+/.test(line)) {
      capturing = true;
      out.push(line.replace(/^##\s+Q\s*:\s*/, ""));
      continue;
    }
    // A bold question heading: `**How much does it cost?**` on its own line.
    // Required to END IN `?` so a bold LABEL (`**Route**:`, `**Lodging**:`) is
    // not mistaken for a question — those are prose, and treating them as FAQ
    // content is how a narrow detector becomes a noisy one.
    const boldQ = line.match(/^\*\*\s*(.+\?)\s*\*\*\s*$/);
    if (boldQ) {
      capturing = true;
      out.push(boldQ[1]);
      continue;
    }
    // A new H1/H2 that is not a `## Q:` ends the current answer block.
    if (/^#{1,2}\s+/.test(line)) {
      capturing = false;
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join("\n");
}

function uniq(nums: number[]): number[] {
  return [...new Set(nums)];
}

function extract(text: string, re: RegExp): number[] {
  const vals: number[] = [];
  for (const m of text.matchAll(re)) {
    // First defined capture group. PRICE_RE is an alternation (unit-before-value
    // OR value-before-unit), so the number is in group 1 or 2 depending on which
    // side matched; reading m[1] unconditionally would throw on the second form.
    const raw = m.slice(1).find((g) => g !== undefined);
    if (raw === undefined) continue;
    const n = parseFloat(raw.replace(/,/g, ""));
    if (!Number.isNaN(n)) vals.push(n);
  }
  return uniq(vals);
}

// Anchored extractors — a number is only captured next to its unit/entity.
const MILES_RE = /(\d+(?:\.\d+)?)\s*-?\s*mile/gi;
const ATTENDANCE_RE = /([\d,]+)\s*\+?\s*(?:attendees|visitors|guests|people|spectators)/gi;
/**
 * OPE-280 rework — price is ADMISSION price, anchored on both sides.
 *
 * The first sweep of all 116 published posts flagged 9, and inspection showed
 * the bare `\$N` pattern was comparing different KINDS of money:
 *
 *   paradise-city-arts-festival   body [100]     vs column [14]
 *   laudholm-nature-crafts        body [25, 500] vs column [10]
 *
 * $100 and $500 are booth/vendor fees; $14 and $10 are gate admission. Neither
 * pair is a contradiction — they are answers to different questions, and the
 * detector was manufacturing conflicts out of a guide doing its job.
 *
 * Requiring an admission word within a short window of the figure keeps the
 * real case (an admission price corrected in the column but not the body) and
 * drops the vendor-fee noise.
 */
const ADMISSION = "(?:admission|ticket|entry|entrance|gate|door)";
const PRICE_RE = new RegExp(
  `(?:${ADMISSION}[^.\\n]{0,40}?\\$\\s*([\\d,]+(?:\\.\\d{1,2})?))` +
    `|(?:\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)[^.\\n]{0,30}?${ADMISSION})`,
  "gi"
);

/**
 * OPE-280 rework — which types are compared against the WHOLE body, not just
 * the FAQ region.
 *
 * The Bristol specimen forced this. Its contradicted claim —
 * "approximately 1.5 miles in length" against the column's "2.5-mile route" —
 * sits in a bold LABEL line (`**Route**: …`), which is prose, not a question.
 * Widening the FAQ extractor could never reach it without also swallowing
 * every bold label in every post.
 *
 * The split is by how many values a type legitimately holds:
 *
 *   distance_miles / attendance_count — SINGLE-FACT about the event. A post has
 *     one route length and one attendance figure. Body and column asserting
 *     wholly disjoint sets is a real contradiction wherever it appears.
 *
 *   price_usd / year — legitimately MULTI-VALUED in a guide. A post lists many
 *     admission prices and many years in prose; comparing those against a
 *     column that cites one would manufacture conflicts. Restricted to the FAQ
 *     region, where the two sides are answering the same question.
 *
 * The disjointness rule still applies either way: a value shared anywhere
 * suppresses the type, so a body that mentions the column's figure at all is
 * never flagged.
 */
const TYPES: { type: FaqConflictType; re: RegExp; wholeBodyToo: boolean }[] = [
  { type: "distance_miles", re: MILES_RE, wholeBodyToo: true },
  { type: "attendance_count", re: ATTENDANCE_RE, wholeBodyToo: true },
  { type: "price_usd", re: PRICE_RE, wholeBodyToo: false },
  // `year` was REMOVED in the OPE-280 rework. Measured across all 116 published
  // posts, its only hit was `caravan-markets`: body [2000] vs column [2026] —
  // a "founded in 2000" history line against the 2026 season. A body year and a
  // column year are routinely about different things (founding, anniversary,
  // the edition being described), so disjointness carries no signal. Recall is
  // not lost, because the type never produced a true positive to lose.
];

// ── OPE-1018 → OPE-1015: word-valued prices ────────────────────────────────
//
// The specimen (`old-deerfield-craft-fairs-vendors-and-visitors-guide`, pre-fix):
// body "Admission is free." ×3 in prose sections; column "Adult gate admission …
// is approximately $8-$10". `faq_coherence` said clean, for TWO reasons, only one
// of which the filer could see without the source:
//
//   1. `PRICE_RE` captures numerals only. "Free" is a price written as a word.
//   2. `price_usd` is FAQ-region-only (`wholeBodyToo: false`), and the body's
//      "free" sits in ordinary prose sections — so even a free→0 extractor on
//      that type would never have looked there.
//
// So this is its own BINARY type rather than a widening of `price_usd`. Free vs
// paid is the one price contradiction that survives a whole-body comparison,
// because it fires only when a side is free-ONLY: one side claims admission is
// free and states no paid admission price anywhere, the other states a paid
// admission price and never says free. A guide listing "fall show $7, spring
// sampler free" has both on the body side and can never fire it — which is the
// precision OPE-280 bought `price_usd` by restricting its region.

/** "free" that is about someone other than the general public is not a price claim. */
const FREE_EXCEPTION =
  "(?:child|children|kids?|seniors?|members?|students?|veterans?|military|under|ages?|toddlers?|infants?|babies)";
const FREE_ADMISSION_RE = new RegExp(
  [
    // "Admission is free", "entry is always free" — not "admission is free for kids"
    `\\b(?:admission|entry|entrance)\\s+(?:is\\s+|are\\s+)?(?:always\\s+|completely\\s+|entirely\\s+|totally\\s+)?free\\b(?![^.\\n]{0,25}\\b${FREE_EXCEPTION}\\b)`,
    // "Free admission" — not "children receive free admission" / "free admission for seniors"
    `(?<!\\b${FREE_EXCEPTION}\\b[^.\\n]{0,25})\\bfree\\s+(?:admission|entry|entrance)\\b(?![^.\\n]{0,25}\\b${FREE_EXCEPTION}\\b)`,
    `\\bno\\s+(?:admission|entry|entrance)\\s+(?:fee|charge|cost)\\b`,
  ].join("|"),
  "gi"
);

/**
 * A paid admission price, for the free-vs-paid rule ONLY. Same anchoring as
 * `PRICE_RE` but sentence-bounded at 80 chars: the specimen column puts 51
 * characters between "admission" and "$8", past `PRICE_RE`'s 40. Widening
 * `PRICE_RE` itself would re-open the booth-fee noise OPE-280 measured; here
 * the other side must be free-only, so the wider window cannot pair two
 * different kinds of money.
 */
const PAID_ADMISSION_RE = new RegExp(
  `(?:${ADMISSION}[^.\\n]{0,80}?\\$\\s*([\\d,]+(?:\\.\\d{1,2})?))` +
    `|(?:\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)[^.\\n]{0,30}?${ADMISSION})`,
  "gi"
);

function freeVsPaid(bodyText: string, colText: string): FaqCoherenceConflict | null {
  FREE_ADMISSION_RE.lastIndex = 0;
  const bodyFree = new RegExp(FREE_ADMISSION_RE.source, "i").test(bodyText);
  const colFree = new RegExp(FREE_ADMISSION_RE.source, "i").test(colText);
  const bodyPaid = extract(bodyText, PAID_ADMISSION_RE).filter((n) => n > 0);
  const colPaid = extract(colText, PAID_ADMISSION_RE).filter((n) => n > 0);
  if (bodyFree && bodyPaid.length === 0 && !colFree && colPaid.length > 0) {
    return { type: "admission_free_vs_paid", bodyValues: [0], columnValues: colPaid };
  }
  if (colFree && colPaid.length === 0 && !bodyFree && bodyPaid.length > 0) {
    return { type: "admission_free_vs_paid", bodyValues: bodyPaid, columnValues: [0] };
  }
  return null;
}

// ── OPE-1015: a categorical type — the venue of ALL events ──────────────────
//
// Specimen column: "All three events are held at Memorial Hall Museum in Old
// Deerfield, Massachusetts." Specimen body: "The Spring and Holiday Samplers are
// held at the Eastern States Exposition's indoor facility about 35 miles south,
// in West Springfield."
//
// Deliberately the narrowest place rule that catches it:
//  - The column side must be a UNIVERSAL claim ("all events", "both shows",
//    "every fair" … held at X). A column naming one event's venue while the body
//    names another event's is a multi-show post doing its job, not a
//    contradiction — the failure the ticket warns is worse than no type.
//  - The body side is any "held/hosted at|in Y" with a capitalised place.
//  - It fires only when Y's SENTENCE shares no distinctive token with X. Venue
//    names have aliases ("the Eastern States Exposition (the Big E)") and towns
//    ("held in Deerfield" vs "Memorial Hall Museum in Old Deerfield"); a sentence
//    that names any part of X anywhere is treated as agreeing.
//  - Generic venue words (hall, museum, fairgrounds …) are not distinctive, so
//    "Memorial Hall" and "Town Hall" do not share a token.
// Note it CANNOT use "does the body mention X at all": the specimen body names
// Memorial Hall Museum for the fall festival, which is correct — the error is
// the word "all".

const PLACE_STOP = new Set(
  (
    "the and of at in on for hall museum center centre park fairgrounds fairground grounds " +
    "fair fairs festival exposition expo building arena club church school street road town " +
    "city county common green farm events event show shows indoor outdoor facility old new " +
    "north south east west massachusetts maine connecticut vermont hampshire rhode island"
  ).split(" ")
);
const PLACE_PHRASE = "((?:[A-Z][\\w'’.&-]*)(?:\\s+(?:of|the|and|&)?\\s*[A-Z][\\w'’.&-]*)*)";
const UNIVERSAL_VENUE_RE = new RegExp(
  `\\b(?:[Aa]ll|[Bb]oth|[Ee]very|[Ee]ach)\\b[^.\\n]{0,40}?\\b(?:held|hosted|take place|takes place)\\s+(?:at|in)\\s+(?:the\\s+)?${PLACE_PHRASE}(?:\\s+in\\s+${PLACE_PHRASE})?`,
  "g"
);
const BODY_VENUE_RE = new RegExp(
  `\\b(?:held|hosted|take place|takes place)\\s+(?:at|in)\\s+(?:the\\s+)?${PLACE_PHRASE}`,
  "g"
);

function placeTokens(text: string): string[] {
  return text
    .replace(/['’]s\b/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3 && !PLACE_STOP.has(t));
}

function venueAllEvents(wholeBody: string, colText: string): FaqCoherenceConflict | null {
  const colPlaces: string[] = [];
  const colTokens = new Set<string>();
  for (const m of colText.matchAll(UNIVERSAL_VENUE_RE)) {
    const name = [m[1], m[2]].filter(Boolean).join(" in ");
    const toks = placeTokens(name);
    if (toks.length === 0) continue;
    colPlaces.push(name);
    toks.forEach((t) => colTokens.add(t));
  }
  if (colPlaces.length === 0) return null;

  const bodyPlaces: string[] = [];
  for (const sentence of wholeBody.split(/(?<=[.!?])\s+|\n+/)) {
    for (const m of sentence.matchAll(BODY_VENUE_RE)) {
      const toks = placeTokens(m[1]);
      if (toks.length === 0) continue;
      const sentenceToks = new Set(placeTokens(sentence));
      const agrees = [...colTokens].some((t) => sentenceToks.has(t));
      if (!agrees) bodyPlaces.push(m[1].replace(/['’]s$/, ""));
    }
  }
  if (bodyPlaces.length === 0) return null;
  return {
    type: "venue_all_events",
    bodyValues: uniqStrings(bodyPlaces),
    columnValues: uniqStrings(colPlaces),
  };
}

function uniqStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Compare the body's `## Q:` FAQ blocks against the column `faqs` for conflicting
 * typed numeric claims. Returns { incoherent, conflicts } — empty when either
 * source lacks FAQ content or no typed claim is fully disjoint.
 */
export function detectFaqIncoherence(
  faqsJson: string | null | undefined,
  body: string | null | undefined
): FaqCoherenceResult {
  const colText = columnFaqText(faqsJson);
  const faqText = bodyFaqText(body);
  const wholeBody = body ?? "";
  if (!colText.trim()) {
    return { incoherent: false, conflicts: [] };
  }

  const conflicts: FaqCoherenceConflict[] = [];
  for (const { type, re, wholeBodyToo } of TYPES) {
    // SINGLE-FACT types are compared against the whole body; multi-valued ones
    // only against the FAQ region. See WHOLE_BODY_TYPES for the reasoning.
    const haystack = wholeBodyToo ? `${faqText}\n${wholeBody}` : faqText;
    if (!haystack.trim()) continue;
    const bodyValues = extract(haystack, re);
    const columnValues = extract(colText, re);
    if (bodyValues.length === 0 || columnValues.length === 0) continue;
    const shared = bodyValues.some((v) => columnValues.includes(v));
    if (!shared) {
      conflicts.push({ type, bodyValues, columnValues });
    }
  }

  // OPE-1015 — both compare against the WHOLE body; see each rule for why that
  // is precise despite prices and venues being multi-valued in a guide.
  const fvp = freeVsPaid(`${faqText}\n${wholeBody}`, colText);
  if (fvp) conflicts.push(fvp);
  const venue = venueAllEvents(wholeBody, colText);
  if (venue) conflicts.push(venue);

  return { incoherent: conflicts.length > 0, conflicts };
}
