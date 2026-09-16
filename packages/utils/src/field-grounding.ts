/**
 * OPE-465 — no field reaches an event row unless a source text supports it.
 *
 * ── The three specimens this is built from ───────────────────────────────
 *
 *   start 2026-11-01 → end 2026-11-30   source: an ad for a ONE-DAY fair on Nov 7
 *   "UMF December Craft Fair", no dates source: "Information regarding the
 *                                       December Craft Fair will be sent out
 *                                       later this year."
 *   start 2024-06-15                    source: a body that is one URL and
 *                                       contains no dates at all
 *
 * Each value is *plausible*. None is a parse error, none throws, none fails a
 * type check. The only thing wrong with them is that no source asserts them,
 * which is exactly the property nothing tested.
 *
 * ── Why deterministic, and not a second model call ───────────────────────
 *
 * The ticket offers "one extra model call" as the standard remedy. This does
 * it with string evidence instead, for three reasons that are specific to this
 * codebase rather than general preference:
 *
 *   1. The existing grounding checks on this path — `groundDateInSource`
 *      (OPE-432) and `groundNameInSources` (OPE-378) — are deterministic, and
 *      a third check that sometimes disagrees with them for model reasons
 *      would be unarguable when it fired.
 *   2. Every verdict here has to be defensible to an operator looking at one
 *      row. "The string `Nov 7` appears at offset 412 and `Nov 1` does not" is
 *      a receipt; "the model said partial" is not.
 *   3. It is exercised by tests that replay the real submissions, and a model
 *      call in that position makes the test a mock of itself.
 *
 * The cost is recall on phrasings the patterns miss. That is why an
 * unrecognised shape resolves to `partial` (keep the value, lower the
 * confidence) and only a *contradicted* one resolves to `unsupported` (drop
 * it). Dropping is reserved for evidence of absence, never absence of
 * evidence — OPE-459 defect 3 is the live reminder of what a gate tuned the
 * other way does: five real events collapsed into one `TBD` row.
 *
 * ⚠️ Fail-safe direction: with NO source text captured, everything is
 * `supported`. A fetch failure must not become a data-loss event.
 */

export type GroundingVerdict = "supported" | "partial" | "unsupported";

export interface FieldGrounding {
  field: string;
  verdict: GroundingVerdict;
  /** Operator-readable, and specific enough to argue with. */
  reason: string;
  /** The text that supports the value, when there is any. */
  span: string | null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/** Every source we hold for one candidate, joined once. */
function joinSources(sources: ReadonlyArray<string | null | undefined>): string {
  return sources
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n");
}

/** A window of the source around a match, for the receipt. */
function spanAround(source: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(source.length, index + length + 40);
  return (
    (start > 0 ? "…" : "") + source.slice(start, end).trim() + (end < source.length ? "…" : "")
  );
}

/**
 * Does the source name this exact calendar day?
 *
 * Accepts the shapes organizers actually write: `Nov 7`, `November 7th`,
 * `7 November`, `11/7`, `11/7/2026`, `2026-11-07`. The day is matched with a
 * digit boundary so `Nov 7` does not satisfy a search for `Nov 70`, and
 * `11/7` does not satisfy `1/7`.
 */
export function sourceNamesDay(isoDate: string, source: string): { hit: boolean; span: string } {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return { hit: false, span: "" };
  const month = MONTHS[m - 1];
  const abbrev = month.slice(0, 3);
  const patterns = [
    // November 7 / Nov. 7th / Nov 7
    new RegExp(`\\b${abbrev}[a-z]*\\.?\\s+0?${d}(?!\\d)(?:st|nd|rd|th)?`, "i"),
    // 7 November / 7th Nov
    new RegExp(`\\b0?${d}(?:st|nd|rd|th)?\\s+${abbrev}[a-z]*\\b`, "i"),
    // 11/7, 11-7, 11/7/26, 11/07/2026
    new RegExp(`(?<!\\d)0?${m}[/-]0?${d}(?!\\d)`),
    // ISO
    new RegExp(`(?<!\\d)${y}-0?${m}-0?${d}(?!\\d)`),
  ];
  for (const re of patterns) {
    const match = re.exec(source);
    if (match) return { hit: true, span: spanAround(source, match.index, match[0].length) };
  }
  return { hit: false, span: "" };
}

/** Does the source name this month at all (without committing to a day)? */
export function sourceNamesMonth(isoDate: string, source: string): boolean {
  const m = Number(isoDate.split("-")[1]);
  if (!m) return false;
  const abbrev = MONTHS[m - 1].slice(0, 3);
  return new RegExp(`\\b${abbrev}[a-z]*\\b`, "i").test(source);
}

/** Last calendar day of the month an ISO date falls in. */
function lastDayOfMonth(isoDate: string): number {
  const [y, m] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A span that is exactly one calendar month, first day to last.
 *
 * This is the shape the `Nov 1 → Nov 30` specimen has, and it is the tell that
 * two required fields were filled from a month-precision reading rather than
 * from anything the source said.
 */
export function isWholeMonthSpan(start: string, end: string): boolean {
  if (!start || !end) return false;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return sy === ey && sm === em && sd === 1 && ed === lastDayOfMonth(end);
}

/**
 * The source says the details do not exist yet.
 *
 * The UMF specimen verbatim: *"Information regarding the December Craft Fair
 * will be sent out later this year."* A sentence stating that details are
 * forthcoming is not an event, and an extractor that produces one from it has
 * produced a fact nobody asserted.
 */
export function sourceStatesDetailsForthcoming(sources: ReadonlyArray<string | null | undefined>): {
  stated: boolean;
  span: string | null;
} {
  const source = joinSources(sources);
  if (!source) return { stated: false, span: null };
  const patterns = [
    /\b(information|details|dates?|flyer|application)\b[^.!?\n]{0,60}\bwill be\b[^.!?\n]{0,40}\b(sent|posted|announced|shared|available|released|out)\b/i,
    /\b(details?|dates?|information)\b[^.!?\n]{0,40}\b(are|is)\b[^.!?\n]{0,20}\b(forthcoming|to follow|coming soon|tbd|tba)\b/i,
    /\bmore (information|details)\b[^.!?\n]{0,40}\blater\b/i,
    /\b(watch|check back|stay tuned)\b[^.!?\n]{0,40}\b(for|soon)\b/i,
  ];
  for (const re of patterns) {
    const match = re.exec(source);
    if (match) {
      return { stated: true, span: spanAround(source, match.index, match[0].length) };
    }
  }
  return { stated: false, span: null };
}

export interface GroundDatesInput {
  startDate?: string | null;
  endDate?: string | null;
  sources: ReadonlyArray<string | null | undefined>;
}

/**
 * Judge `start_date` and `end_date` against the text they came from.
 *
 * Deliberately narrower than "every field": dates are where all three
 * specimens landed, they are the fields a required-field constraint pressures
 * a model into inventing, and they are the ones whose wrongness is invisible
 * downstream (a fabricated past date is filtered out of every forward-looking
 * view, so nobody ever sees it to correct it).
 */
export function groundEventDates(input: GroundDatesInput): FieldGrounding[] {
  const source = joinSources(input.sources);
  const out: FieldGrounding[] = [];
  const fields: Array<["start_date" | "end_date", string | null | undefined]> = [
    ["start_date", input.startDate],
    ["end_date", input.endDate],
  ];

  for (const [field, value] of fields) {
    if (!value) continue;
    if (!source) {
      out.push({
        field,
        verdict: "supported",
        reason: "no source text was captured; nothing to contradict the value",
        span: null,
      });
      continue;
    }
    const day = sourceNamesDay(value, source);
    if (day.hit) {
      out.push({
        field,
        verdict: "supported",
        reason: `the source names ${value}`,
        span: day.span,
      });
      continue;
    }
    if (sourceNamesMonth(value, source)) {
      out.push({
        field,
        verdict: "partial",
        reason: `the source names the month of ${value} but not that day`,
        span: null,
      });
      continue;
    }
    out.push({
      field,
      verdict: "unsupported",
      reason: `the source names neither ${value} nor its month`,
      span: null,
    });
  }

  // The manufactured-span rule. Both ends are month-precision guesses AND the
  // pair spans exactly one calendar month AND the source names some OTHER day
  // in that month — i.e. the source was specific and the extractor was not.
  const start = input.startDate ?? null;
  const end = input.endDate ?? null;
  if (start && end && source && isWholeMonthSpan(start, end)) {
    const bothWeak = out
      .filter((r) => r.field === "start_date" || r.field === "end_date")
      .every((r) => r.verdict !== "supported");
    if (bothWeak) {
      const otherDay = namedDayInSameMonth(start, source);
      for (const r of out) {
        if (r.field !== "start_date" && r.field !== "end_date") continue;
        r.verdict = "unsupported";
        r.reason = otherDay
          ? `a whole-month span neither end of which the source states, while the source does name ${otherDay} — the range was manufactured to fill two required fields`
          : "a whole-month span neither end of which the source states";
        r.span = null;
      }
    }
  }

  return out;
}

/** The first day the source names in the same month as `isoDate`, if any. */
function namedDayInSameMonth(isoDate: string, source: string): string | null {
  const [y, m] = isoDate.split("-").map(Number);
  const last = lastDayOfMonth(isoDate);
  for (let d = 1; d <= last; d++) {
    const candidate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (sourceNamesDay(candidate, source).hit) return candidate;
  }
  return null;
}

export interface EventGroundingDecision {
  /** Field names whose value must NOT be written. */
  dropFields: string[];
  /** True when the submission should not create an event at all. */
  refuseCreate: boolean;
  /** Why, in one line, for the operator-facing record. */
  reason: string | null;
  results: FieldGrounding[];
}

/**
 * Turn per-field verdicts into the two decisions a writer can act on.
 *
 * Abstention is the point: `unsupported` means the field is not written, and a
 * required-field constraint must never be satisfiable by inference. The
 * refuse-to-create case is narrower still — it needs BOTH no usable date AND a
 * source that says the details are forthcoming, because "no date" alone is a
 * legitimate submission this site accepts every week.
 */
export function decideEventGrounding(input: GroundDatesInput): EventGroundingDecision {
  const results = groundEventDates(input);
  const dropFields = results.filter((r) => r.verdict === "unsupported").map((r) => r.field);

  const startDropped = !input.startDate || dropFields.includes("start_date");
  const forthcoming = sourceStatesDetailsForthcoming(input.sources);
  const refuseCreate = startDropped && forthcoming.stated;

  return {
    dropFields,
    refuseCreate,
    reason: refuseCreate
      ? `the source states the details are not available yet (${forthcoming.span ?? "no span"}) and no supported start date remains`
      : dropFields.length > 0
        ? // The per-field reason, not a generic one: on the whole-month
          // specimen it names the day the source DID state, which is the
          // single most useful thing an operator can be told here.
          `${dropFields.join(", ")}: ${
            results.find((r) => r.verdict === "unsupported")?.reason ??
            "not supported by the source"
          }`
        : null,
    results,
  };
}

/**
 * The verdict AS the confidence, replacing the `medium → 0.6` constant.
 *
 * OPE-457 scope 3 asked for `event_data_citations.confidence` to stop being a
 * constant. The measured reason it was one lives upstream in
 * `fieldConfidenceLadder`: with no JSON-LD on the page, every non-null field
 * became `medium`, i.e. 0.6. A grounding verdict is an actual measurement of
 * the value against its source, so it is the right thing to store — and
 * `null` where there is no verdict, because per OPE-457 a null beats a
 * constant that looks measured.
 */
export function groundingConfidence(verdict: GroundingVerdict | undefined): number | null {
  switch (verdict) {
    case "supported":
      return 0.95;
    case "partial":
      return 0.5;
    case "unsupported":
      return 0;
    default:
      return null;
  }
}
