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

export type FaqConflictType = "distance_miles" | "attendance_count" | "price_usd";

export interface FaqCoherenceConflict {
  type: FaqConflictType;
  bodyValues: number[];
  columnValues: number[];
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

  return { incoherent: conflicts.length > 0, conflicts };
}
