/**
 * OPE-176 — detect an exhibitor/vendor roster embedded in an inbound email body.
 *
 * Pure + deterministic so it's unit-tested independently of the Durable-Object
 * workflow. Recognises the common "heading + bulleted list" shape (the Art in
 * the Park evidence: `*Art in the Park Vendors 2026*` followed by ~29
 * `   - *Vendor Name*` bullets). Anchors on a bullet RUN that is preceded by a
 * roster-keyword heading, which ignores the wrapped-prose lines that merely
 * mention "vendor" (e.g. "…served as a *vendor application*…").
 *
 * Names are normalised (strip Gmail bold/italic markers, decode HTML entities,
 * fold unicode dashes, collapse whitespace) so the captured roster is clean.
 * This module ONLY detects — the caller stages the result for operator review
 * (OPE-175/176, stage-for-review); it never creates or links vendors.
 */
import { decodeHtmlEntities } from "../helpers.js";

const ROSTER_KEYWORD =
  /(vendors?|exhibitors?|artisans?|makers?|crafters?|participants?|line[- ]?up|booths?)/i;
/** A list item: `-`/`*`/`•`/`·` bullets or `1.`/`1)` numbering, then a value. */
const BULLET = /^\s*(?:[-*•·‣▪◦●○]|\d+[.)])\s+(.+?)\s*$/;

const MIN_ROSTER = 3;
const MAX_ROSTER = 300;
const MAX_NAME_LEN = 80;
const MAX_NAME_WORDS = 10;

function cleanName(raw: string): string {
  let s = raw.trim();
  // Strip surrounding Gmail bold/italic markers (**name**, *name*, _name_).
  s = s
    .replace(/^[*_]+/, "")
    .replace(/[*_]+$/, "")
    .trim();
  s = decodeHtmlEntities(s);
  // Unicode dashes (– — ‒ …) → hyphen; collapse internal whitespace.
  s = s.replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
  return s;
}

function isPlausibleName(s: string): boolean {
  if (s.length === 0 || s.length > MAX_NAME_LEN) return false;
  if (s.split(/\s+/).length > MAX_NAME_WORDS) return false; // reject prose
  if (!/[A-Za-z0-9]/.test(s)) return false; // must carry a letter/number
  return true;
}

/**
 * Return the detected roster names (deduped, order-preserved), or `[]` when the
 * body carries no confidently-detected roster (fewer than MIN_ROSTER items, or
 * no roster-keyword heading precedes the list).
 */
export function detectRosterNames(body: string | null | undefined): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const isBullet = (l: string) => BULLET.test(l);

  let i = 0;
  while (i < lines.length) {
    if (!isBullet(lines[i])) {
      i++;
      continue;
    }
    // Extent of this consecutive bullet run [i, j).
    let j = i;
    while (j < lines.length && isBullet(lines[j])) j++;

    if (j - i >= MIN_ROSTER) {
      // Look back up to 4 non-blank lines for a roster-keyword heading.
      let hasHeading = false;
      let seenNonBlank = 0;
      for (let k = i - 1; k >= 0 && seenNonBlank < 4; k--) {
        const bare = lines[k].replace(/[*_#>]/g, "").trim();
        if (bare === "") continue;
        seenNonBlank++;
        if (bare.length <= 80 && ROSTER_KEYWORD.test(bare)) {
          hasHeading = true;
          break;
        }
      }
      if (hasHeading) {
        const names: string[] = [];
        const seen = new Set<string>();
        for (let k = i; k < j && names.length < MAX_ROSTER; k++) {
          const m = lines[k].match(BULLET);
          if (!m) continue;
          const name = cleanName(m[1]);
          if (!isPlausibleName(name)) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          names.push(name);
        }
        // The MIN_ROSTER gate is on the RUN length (already checked) — that's the
        // "this is a list under a vendor heading" signal. Return the unique
        // plausible names it yielded (dedup/prose-filtering may drop it below
        // MIN_ROSTER; that's fine, the run already qualified it).
        if (names.length > 0) return names;
      }
    }
    i = j;
  }
  return [];
}
