/**
 * OPE-837 — read an ADMISSION price range off a ticketing page.
 *
 * ## Why this is not `Math.min`/`Math.max` over the dollar signs
 *
 * Measured on the specimen's ticketing form, the page carries eight distinct
 * dollar amounts:
 *
 *   $35.00  Adult VIP Early Entry Ticket        <- admission
 *   $25.00  Adult GENERAL ADMISSION Ticket      <- admission
 *   $10.00  Child (12 and older) ... Ticket     <- admission
 *   $60.00  Maine Pairings Experience           <- add-on experience
 *   $25.00  Small/Medium/Large T-Shirt          <- merchandise
 *   $1.75 / $1.25 / $0.50  Booking Fee          <- fees
 *
 * The correct answer is min $10, max $35. A naive scan returns $0.50–$60.00 —
 * both ends wrong, and wrong in the direction that publishes a false price to
 * visitors. So a price counts only when the text immediately before it names
 * an ADMISSION, and not when it names a fee, a garment or an add-on.
 *
 * ## The sentence boundary is the load-bearing part
 *
 * The label window is cut at the previous sentence end. Without that cut, the
 * $60 add-on inherits the word "entry" from the end of the PRECEDING sentence
 * ("...photo ID for age verification upon entry. Maine Pairings Experience
 * $60.00") and is admitted as an admission price. That single boundary is the
 * difference between a $35 maximum and a $60 one.
 *
 * Pure — no I/O.
 */

/** Tokens that make a price an admission price. */
const ADMISSION_TOKEN =
  /\b(?:tickets?|admissions?|admit|entry|entrance|gate|passes?|pass|wristbands?|day\s*pass|general\s+admission)\b/i;

/**
 * Tokens that disqualify a price even when an admission word is also present.
 *
 * Checked AFTER the admission token and wins over it: "Booking Fee" sits
 * beside "Ticket" constantly, and the fee is not the price of admission.
 */
const DISQUALIFYING_TOKEN =
  /\b(?:fees?|surcharge|processing|service\s+charge|shirts?|t-?shirts?|hoodie|merch(?:andise)?|poster|mug|donations?|donate|sponsors?|sponsorship|shipping|tax(?:es)?|parking|camping|hook-?up|booth|stall|vendor|exhibitor|application|deposit|per\s+night|lodging|hotel|membership|raffle|auction|gift\s*card|experience|add-?on|upgrade\s+package|tour)\b/i;

/** How much text before the `$` can act as the label. */
const LABEL_WINDOW = 120;

export interface AdmissionPriceResult {
  /** Lowest qualifying admission price, or null when none qualified. */
  min: number | null;
  /** Highest qualifying admission price, or null when none qualified. */
  max: number | null;
  /** Every qualifying amount, ascending — for the citation excerpt. */
  values: number[];
  /** Amounts seen but rejected, with why. Diagnostic; never published. */
  rejected: Array<{ amount: number; label: string; reason: "no-admission-token" | "disqualified" }>;
}

const PRICE_RE = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?\b/g;

/**
 * A price whose label says "free" is real and meaningful (under-12 free), but
 * a $0 does not belong in a published range that also carries paid tiers — it
 * reads as "tickets from $0". Kept out of min/max, reported in `values`.
 */
function isUsableAmount(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n < 10_000;
}

/**
 * Cut the label window back to the start of the current sentence.
 *
 * Also cuts at the end of the PREVIOUS price, so "$35.00 Booking Fee: $1.75"
 * gives the $1.75 a label of "Booking Fee:" rather than one that reaches back
 * across the $35 and picks up its "Ticket".
 */
function labelFor(text: string, matchStart: number, prevMatchEnd: number): string {
  const windowStart = Math.max(0, matchStart - LABEL_WINDOW, prevMatchEnd);
  const raw = text.slice(windowStart, matchStart);
  // Last sentence boundary: a period/question/exclamation followed by space,
  // or a hard line break. Deliberately NOT a bare "." so "$35.00" and
  // "Co." do not split a label.
  const boundary = raw.search(/(?:[.!?]\s+|\n)(?![^]*(?:[.!?]\s+|\n))/);
  const cut = boundary >= 0 ? raw.slice(boundary).replace(/^[.!?\s]+/, "") : raw;
  return cut.replace(/\s+/g, " ").trim();
}

/**
 * Index of the start of the sentence containing `pos`.
 *
 * Used as a sentence IDENTITY (two prices share a sentence when this returns
 * the same value), which is why it returns an index rather than the text.
 */
function sentenceStartIndex(text: string, pos: number): number {
  const before = text.slice(0, pos);
  let best = 0;
  const re = /[.!?]\s|\n/g;
  for (const m of before.matchAll(re)) {
    best = (m.index ?? 0) + m[0].length;
  }
  return best;
}

/**
 * Parse an admission price range out of page text.
 *
 * Returns nulls rather than guessing when nothing qualifies — an absent price
 * is a correct answer, and is strictly better than a confident wrong one on a
 * field that renders to visitors.
 */
export function parseAdmissionPrices(text: string | null | undefined): AdmissionPriceResult {
  const empty: AdmissionPriceResult = { min: null, max: null, values: [], rejected: [] };
  if (!text) return empty;

  const flat = text.replace(/\s+/g, " ");
  const values: number[] = [];
  const rejected: AdmissionPriceResult["rejected"] = [];

  // Sentences that already yielded an admission price. A price list continues
  // across commas — "Admission $8 for adults, $5 for children under 12" — and
  // only the FIRST amount carries the word "Admission". Without this the $5 is
  // dropped and the range collapses to $8-$8, which is the shape most small
  // fair sites actually print.
  const admittingSentences = new Set<number>();

  let prevEnd = 0;
  PRICE_RE.lastIndex = 0;
  for (const m of flat.matchAll(PRICE_RE)) {
    const start = m.index ?? 0;
    const label = labelFor(flat, start, prevEnd);
    const sentence = sentenceStartIndex(flat, start);
    prevEnd = start + m[0].length;

    const whole = Number(m[1].replace(/,/g, ""));
    const cents = m[2] ? Number(m[2]) / 100 : 0;
    const amount = whole + cents;

    // Disqualification is checked FIRST so inheritance can never rescue a
    // booking fee, a T-shirt or an add-on that happens to share a sentence
    // with a real ticket price. On the specimen's form the fees sit directly
    // beside the admission tiers, so this ordering is what keeps $1.75 out.
    if (DISQUALIFYING_TOKEN.test(label)) {
      rejected.push({ amount, label, reason: "disqualified" });
      continue;
    }

    const named = ADMISSION_TOKEN.test(label);
    const inherited = !named && admittingSentences.has(sentence);
    if (!named && !inherited) {
      rejected.push({ amount, label, reason: "no-admission-token" });
      continue;
    }
    if (named && isUsableAmount(amount)) admittingSentences.add(sentence);
    values.push(amount);
  }

  const usable = values.filter(isUsableAmount).sort((a, b) => a - b);
  if (usable.length === 0) return { ...empty, values: values.sort((a, b) => a - b), rejected };

  return {
    min: usable[0],
    max: usable[usable.length - 1],
    values: usable,
    rejected,
  };
}
