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
    // 11/7, 11-7, 11/7/26, 11/07/2026. The leading digit boundary is a
    // consumed `(?:^|\\D)` + capture group, NOT a lookbehind: this module is
    // in the utils barrel, which reaches the browser, and lookbehind needs
    // Safari 16.4 — above the floor (OPE-1128, docs/browser-support-floor.md).
    new RegExp(`(?:^|\\D)(0?${m}[/-]0?${d})(?!\\d)`),
    // ISO
    new RegExp(`(?:^|\\D)(${y}-0?${m}-0?${d})(?!\\d)`),
  ];
  for (const re of patterns) {
    const match = re.exec(source);
    if (match) {
      // A pattern with a capture group consumed its boundary char; skip it.
      const hit = match[1] ?? match[0];
      const start = match.index + match[0].length - hit.length;
      return { hit: true, span: spanAround(source, start, hit.length) };
    }
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

/**
 * OPE-1332 — does the source state this day WITH its year? `sourceNamesDay`
 * matches "October 15th" for any year, and the year check upstream only asks
 * whether the year appears ANYWHERE in the text — so "our 2027 Lilac
 * Festival … our planning meeting on October 15th" grounded an invented
 * 2027-10-15. A year counts only when it is written as part of the same date
 * expression: "Oct 15, 2027", "October 15th 2027", "15 October 2027",
 * "10/15/2027", "10/15/27", or ISO.
 */
export function sourceNamesDayWithYear(isoDate: string, source: string): boolean {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return false;
  const abbrev = MONTHS[m - 1].slice(0, 3);
  const yy = String(y).slice(2);
  const patterns = [
    // October 15, 2027 / Oct. 15th 2027 / a range ending in the year:
    // "October 15-16, 2027", "May 2 & 3, 2027", "Oct 15 – 17 2027"
    new RegExp(
      `\\b${abbrev}[a-z]*\\.?\\s+0?${d}(?:st|nd|rd|th)?` +
        `(?:\\s*(?:[-–—]|&|and|to)\\s*\\d{1,2}(?:st|nd|rd|th)?)?,?\\s+${y}(?!\\d)`,
      "i"
    ),
    // 15 October 2027 / 15th Oct, 2027
    new RegExp(`\\b0?${d}(?:st|nd|rd|th)?\\s+${abbrev}[a-z]*\\.?,?\\s+${y}(?!\\d)`, "i"),
    // 10/15/2027, 10-15-27
    new RegExp(`(?:^|\\D)0?${m}[/-]0?${d}[/-](?:${y}|${yy})(?!\\d)`),
    // ISO
    new RegExp(`(?:^|\\D)${y}-0?${m}-0?${d}(?!\\d)`),
  ];
  return patterns.some((re) => re.test(source));
}

/** Days a year-less mention may sit in the past and still mean this year's date. */
export const YEARLESS_DAY_LOOKBACK_DAYS = 60;

/**
 * OPE-1332 — the one year a year-less day expression supports: the first
 * occurrence of that month-day on or after `reference − 60 days`. An email
 * sent 2026-10-03 that says "October 15th" means 2026-10-15; it cannot also
 * support 2027-10-15. The lookback keeps a message that mentions a day just
 * past ("our fair on September 20th was a success") anchored to this year.
 */
export function impliedYearForYearlessDay(isoDate: string, reference: Date): number | null {
  const [, m, d] = isoDate.split("-").map(Number);
  if (!m || !d) return null;
  const floor = reference.getTime() - YEARLESS_DAY_LOOKBACK_DAYS * 86_400_000;
  for (let y = reference.getUTCFullYear() - 1; y <= reference.getUTCFullYear() + 1; y++) {
    if (Date.UTC(y, m - 1, d) >= floor) return y;
  }
  return null;
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
  /**
   * OPE-1332 — when the source was written (an email's arrival). Decides which
   * YEAR a year-less day expression ("October 15th") refers to. Defaults to
   * now, which is right for the email lane: it grounds within seconds of
   * arrival. A replay of a months-old message should pass the received time.
   */
  referenceDate?: Date | null;
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
      // OPE-1332 — the day is named; is THIS year? Only when the year is part
      // of the date expression itself, or when the year-less day's own next
      // occurrence is this one. Otherwise the year came from some other
      // sentence ("our 2027 festival … on October 15th").
      //
      // `partial`, NOT `unsupported`: on ONE candidate this is ambiguous, not
      // contradicted — "our 2027 show will be June 5th", sent in January 2026,
      // has exactly this shape and means 2027. Dropping is reserved for
      // evidence of absence (see the header). The evidence-based refusal is in
      // the email fan-out: two candidates from one year-less day expression
      // (`yearlessDaySplitLosers`), because one phrase cannot be two dates.
      const reference = input.referenceDate ?? new Date();
      const implied = impliedYearForYearlessDay(value, reference);
      const year = Number(value.slice(0, 4));
      if (!sourceNamesDayWithYear(value, source) && implied !== null && year !== implied) {
        out.push({
          field,
          verdict: "partial",
          reason:
            `the source names ${value.slice(5)} without a year, which as of ` +
            `${reference.toISOString().slice(0, 10)} means ${implied}-${value.slice(5)}; ` +
            `the year ${year} was taken from elsewhere in the text`,
          span: day.span,
        });
        continue;
      }
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

/**
 * OPE-1332 — which candidates of ONE extraction re-used the same year-less day
 * expression under a different year. Returns the indexes to refuse.
 *
 * The specimen: "We are beginning to plan our 2027 Lilac Festival … our
 * planning meeting on October 15th" became TWO candidates, 2026-10-15 and
 * 2027-10-15. The source states Oct 15 once, with no year; as of the email
 * (2026-10-03) that is 2026-10-15. The 2027 twin is the over-split: the same
 * phrase cannot be two dates. A candidate is refused only when a SIBLING holds
 * the same month-day with the implied year — a lone candidate is never refused
 * here (its year may be legitimately borrowed; `groundEventDates` marks it
 * `partial` instead).
 */
export function yearlessDaySplitLosers(
  candidates: ReadonlyArray<{ startDate?: string | null }>,
  sources: ReadonlyArray<string | null | undefined>,
  referenceDate: Date = new Date()
): number[] {
  const source = joinSources(sources);
  if (!source) return [];
  const losers: number[] = [];
  candidates.forEach((c, i) => {
    const value = c.startDate;
    if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return;
    const iso = value.slice(0, 10);
    if (!sourceNamesDay(iso, source).hit || sourceNamesDayWithYear(iso, source)) return;
    const implied = impliedYearForYearlessDay(iso, referenceDate);
    if (implied === null || Number(iso.slice(0, 4)) === implied) return;
    const twin = candidates.some(
      (o, j) =>
        j !== i &&
        typeof o.startDate === "string" &&
        o.startDate.slice(5, 10) === iso.slice(5, 10) &&
        Number(o.startDate.slice(0, 4)) === implied
    );
    if (twin) losers.push(i);
  });
  return losers;
}
