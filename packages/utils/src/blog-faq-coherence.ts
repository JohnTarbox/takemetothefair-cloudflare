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

export type FaqConflictType = "distance_miles" | "attendance_count" | "price_usd" | "year";

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
 * Text of the body's `## Q: …` FAQ blocks (heading + prose up to the next H1/H2),
 * skipping fenced code. Mirrors the Tier-2 extraction the public page uses so we
 * compare the SAME FAQ region the reader sees, not arbitrary body prose.
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
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isNaN(n)) vals.push(n);
  }
  return uniq(vals);
}

// Anchored extractors — a number is only captured next to its unit/entity.
const MILES_RE = /(\d+(?:\.\d+)?)\s*-?\s*mile/gi;
const ATTENDANCE_RE = /([\d,]+)\s*\+?\s*(?:attendees|visitors|guests|people|spectators)/gi;
const PRICE_RE = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
const YEAR_RE = /\b(20\d{2})\b/g;

const TYPES: { type: FaqConflictType; re: RegExp }[] = [
  { type: "distance_miles", re: MILES_RE },
  { type: "attendance_count", re: ATTENDANCE_RE },
  { type: "price_usd", re: PRICE_RE },
  { type: "year", re: YEAR_RE },
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
  const bodyText = bodyFaqText(body);
  if (!colText.trim() || !bodyText.trim()) {
    return { incoherent: false, conflicts: [] };
  }

  const conflicts: FaqCoherenceConflict[] = [];
  for (const { type, re } of TYPES) {
    const bodyValues = extract(bodyText, re);
    const columnValues = extract(colText, re);
    if (bodyValues.length === 0 || columnValues.length === 0) continue;
    const shared = bodyValues.some((v) => columnValues.includes(v));
    if (!shared) {
      conflicts.push({ type, bodyValues, columnValues });
    }
  }

  return { incoherent: conflicts.length > 0, conflicts };
}
