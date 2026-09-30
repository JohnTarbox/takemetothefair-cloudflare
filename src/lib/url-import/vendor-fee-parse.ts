/**
 * OPE-817 — read tiered and bundled vendor-fee copy deterministically.
 *
 * ## The specimen
 *
 * Manchester Grange #172 (inbound `614d0dfb`) advertises:
 *
 *   > first floor **$25 each or 2/$45**; second floor **$20 each or 2/$35**
 *
 * The extractor wrote `vendor_fee_min = 2000`, `vendor_fee_max = 4500` — it
 * took the **two-table bundle price as the per-table maximum**. The correct
 * per-table range is $20–$25, so the published figure overstated the price a
 * vendor pays by ~80%.
 *
 * Two things make that worse than an ordinary parse bug:
 *
 * 1. **It reads as plausible.** Nothing about "$20–$45" looks anomalous on
 *    review, and `vendor_fee_*` is visitor-facing. The fee is the single number
 *    a vendor uses to decide whether to apply.
 * 2. **It was non-deterministic.** The sibling row from the same email got
 *    2000/2500 correctly. Identical input, different output.
 *
 * ## Why a deterministic parse rather than more fixtures or a tighter prompt
 *
 * The ticket offers three ways to make a green run mean something: run the
 * fixtures enough times, constrain the prompt, or parse deterministically ahead
 * of the model. Only the third actually works.
 *
 * Repeated runs cost real model calls and still only bound the failure rate —
 * they cannot prove the next call is right. A tighter prompt improves the odds
 * and remains a probability. This is a **regex-shaped problem**: the copy uses
 * a small, closed vocabulary ("each", "per table", "N for $X", "N/$X"), and a
 * parser over that vocabulary either matches or does not, the same way every
 * time.
 *
 * So the model's min/max is treated as a fallback and this parser wins whenever
 * it finds an explicit per-unit price. The model keeps the job it is good at —
 * finding the fee sentence in a page of prose — and loses the job it is bad at,
 * which is arithmetic about units.
 */

/** What the copy actually says about price. */
export interface ParsedVendorFee {
  /** Lowest PER-UNIT price in dollars. Never a bundle total. */
  perUnitMin: number | null;
  /** Highest PER-UNIT price in dollars. Never a bundle total. */
  perUnitMax: number | null;
  /**
   * Bundle offers found, e.g. `{ quantity: 2, total: 45 }` for "2/$45".
   *
   * Deliberately NOT folded into the range. A bundle is a discount on buying
   * two, not a more expensive table — reporting $45 as the max inverts what it
   * means. These belong in `vendorFeeNotes`, which is where the surviving
   * Manchester Grange row's tier table was placed by hand.
   */
  bundles: Array<{ quantity: number; total: number }>;
  /** True when at least one per-unit price was found explicitly. */
  matched: boolean;
}

/**
 * Money, with optional cents and thousands separators. `$1,200.50`, `$25`, `25`.
 *
 * The `$` is optional because organizer copy drops it constantly
 * ("tables are 25 each"), but a bare number is only read as money when an
 * adjacent price word licenses it — see the patterns below.
 */
const MONEY = String.raw`\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Bundle offers: "2/$45", "2 for $45", "two for $45".
 *
 * Matched FIRST and removed from the text, so the bundle total can never be
 * picked up afterwards as a per-unit price. That ordering is the whole fix —
 * the old failure was a bundle total surviving into the max.
 */
const BUNDLE_UNIT = String.raw`(?:\s+(?:tables?|booths?|spaces?|spots?|sites?))?`;
const BUNDLE_PATTERNS: RegExp[] = [
  // "2/$45", "2 for $45", "2 tables for $45"
  new RegExp(String.raw`(\d+)${BUNDLE_UNIT}\s*(?:/|\bfor\b)\s*${MONEY}`, "gi"),
  // ⚠️ The unit noun is optional AND allowed between the quantity and "for".
  // Without it "Two tables for $45" left the bundle un-excised, and $45 then
  // matched as a per-unit price — the exact defect, via a different sentence.
  new RegExp(String.raw`\b(two|three|four)${BUNDLE_UNIT}\s+for\s+${MONEY}`, "gi"),
];

const WORD_QUANTITY: Record<string, number> = { two: 2, three: 3, four: 4 };

/**
 * Per-unit prices: "$25 each", "$25 per table", "$25/table", "$25 a space".
 *
 * The unit word is required. Without it a bare "$45" in "2/$45" would read as a
 * per-unit price, which is exactly the defect.
 */
const UNIT_WORDS = String.raw`each|per\s+(?:table|space|booth|spot|site|vendor|day)|a\s+(?:table|space|booth)|/\s*(?:table|space|booth)`;
const PER_UNIT_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${MONEY}\s*(?:${UNIT_WORDS})`, "gi"),
  // "tables are $25", "booth fee $25", "spaces $20".
  //
  // ⚠️ The `\$` here is REQUIRED, unlike in `MONEY` generally. Without it this
  // pattern read "…per space; after Aug 1, $30" as a price of **1**, because
  // "Aug 1" sits within the lookahead window of the word "space". A bare
  // number near a unit noun is a date as often as it is a price.
  new RegExp(
    String.raw`\b(?:table|tables|booth|booths|space|spaces|spot|spots|site|sites)\b[^.$\n]{0,24}?\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`,
    "gi"
  ),
];

/**
 * Parse vendor-fee copy into per-unit bounds plus the bundles found.
 *
 * Returns `matched: false` when no explicit per-unit price is present — the
 * caller then keeps whatever the model produced rather than overriding it with
 * nothing. An absent parse must not erase a real value.
 */
export function parseVendorFeeCopy(text: string | null | undefined): ParsedVendorFee {
  const empty: ParsedVendorFee = {
    perUnitMin: null,
    perUnitMax: null,
    bundles: [],
    matched: false,
  };
  if (!text || typeof text !== "string") return empty;

  let working = text;
  const bundles: Array<{ quantity: number; total: number }> = [];

  // 1. Bundles first, and EXCISED. A bundle total left in the text is a
  //    per-unit price waiting to be mis-read — which is the reported defect.
  for (const re of BUNDLE_PATTERNS) {
    working = working.replace(re, (whole, qtyRaw: string, totalRaw: string) => {
      const quantity = WORD_QUANTITY[String(qtyRaw).toLowerCase()] ?? Number(qtyRaw);
      const total = toNumber(totalRaw);
      // A "quantity" of 1 is not a bundle, and a huge one is a year or a zip
      // code that happened to sit next to a price.
      if (Number.isFinite(quantity) && quantity > 1 && quantity <= 50 && total != null) {
        bundles.push({ quantity, total });
        return " ";
      }
      return whole;
    });
  }

  // 2. Per-unit prices from what remains.
  const perUnit: number[] = [];
  for (const re of PER_UNIT_PATTERNS) {
    for (const m of working.matchAll(re)) {
      const v = toNumber(m[1]);
      if (v != null) perUnit.push(v);
    }
  }

  if (perUnit.length === 0) {
    // No explicit per-unit price. Bundles alone are NOT a range: "2/$45" says
    // nothing reliable about one table, and dividing would invent a number the
    // organizer never published.
    return { ...empty, bundles };
  }

  return {
    perUnitMin: Math.min(...perUnit),
    perUnitMax: Math.max(...perUnit),
    bundles,
    matched: true,
  };
}

/** Render bundles for `vendorFeeNotes`, so the detail survives. */
export function describeBundles(bundles: ParsedVendorFee["bundles"]): string {
  if (bundles.length === 0) return "";
  return bundles.map((b) => `${b.quantity} for $${b.total}`).join("; ");
}

/** The three fee fields, as the extractor holds them (dollars, not cents). */
export interface VendorFeeFields {
  vendorFeeMin: number | null;
  vendorFeeMax: number | null;
  vendorFeeNotes: string | null;
}

/**
 * Let the deterministic parse correct the model's arithmetic.
 *
 * The model is good at finding the fee sentence in a page of prose and bad at
 * reasoning about units. So it keeps the first job, and loses the second:
 * whenever the copy states an explicit per-unit price, that wins.
 *
 * ⚠️ Only overrides when `matched` is true. An absent parse must never erase a
 * real value the model found — a page saying "booths from $50" has no per-unit
 * keyword and the model's answer is the only one there is.
 *
 * Bundle detail is appended to the notes rather than dropped, because that is
 * genuine information a vendor wants and it is where the surviving Manchester
 * Grange row's tier table was placed by hand.
 */
export function reconcileVendorFee(
  fields: VendorFeeFields,
  sourceText?: string | null
): VendorFeeFields {
  // The notes are the fee sentence the model already isolated, so they are the
  // highest-signal text to parse. Fall back to the wider source.
  const parsed = parseVendorFeeCopy(fields.vendorFeeNotes || sourceText);
  if (!parsed.matched) {
    // Still record bundles we found, even with no per-unit price to correct.
    const bundleNote = describeBundles(parsed.bundles);
    if (!bundleNote) return fields;
    const notes = fields.vendorFeeNotes
      ? fields.vendorFeeNotes.includes(bundleNote)
        ? fields.vendorFeeNotes
        : `${fields.vendorFeeNotes} (${bundleNote})`
      : bundleNote;
    return { ...fields, vendorFeeNotes: notes.slice(0, 500) };
  }

  const bundleNote = describeBundles(parsed.bundles);
  const baseNotes = fields.vendorFeeNotes ?? "";
  const notes =
    bundleNote && !baseNotes.includes(bundleNote)
      ? `${baseNotes ? `${baseNotes} ` : ""}(${bundleNote})`.trim()
      : baseNotes;

  return {
    vendorFeeMin: parsed.perUnitMin,
    vendorFeeMax: parsed.perUnitMax,
    vendorFeeNotes: notes ? notes.slice(0, 500) : null,
  };
}
