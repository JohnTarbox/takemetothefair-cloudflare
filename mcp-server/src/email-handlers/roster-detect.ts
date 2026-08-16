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
/**
 * OPE-405 — one roster line, structured.
 *
 * The bullet path only ever produced a name. A placement list carries the booth
 * NUMBER and the type of work too, and both matter downstream: the number is how
 * an operator reconciles against the map PDF, and the craft ("Photos", "crochet")
 * is often the only thing that identifies a person's business later. Winthrop
 * spot 21 read "Carolyn Smith / Ptg" and was really Maine Cardworks Inc.
 */
export interface RosterEntry {
  /** Booth/spot number when the roster is numbered. */
  position: number | null;
  name: string;
  /** Type of work / craft, when the roster carries a second column. */
  detail: string | null;
}

/**
 * OPE-405 — rosters that arrive as a MARKDOWN TABLE.
 *
 * `env.AI.toMarkdown` renders a PDF placement list as a table, not as bullets:
 *
 *   | Name | Type of Work |
 *   | 3 | Clair Hersom | Authors |
 *   | 8 | Paul Menice  | Photos  |
 *
 * `BULLET` cannot match those rows, so the 34-spot Winthrop roster read as zero
 * names even once its text was in hand. Verified against the real attachment:
 * this yields 30 entries from `2026-Winthrop-Art-Festival-Names-Final.pdf`.
 *
 * No roster-keyword heading is required here, unlike the bullet path. A table
 * whose rows are `<number> | <name> | <craft>` is already a strong shape — the
 * heading rule exists to stop prose bullets being mistaken for a list, and prose
 * does not accidentally form numbered table rows. The MIN_ROSTER gate still
 * applies, so a stray two-row table cannot qualify.
 */
export function detectRosterTable(text: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    // Split on pipes, dropping the empty edges produced by leading/trailing |.
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c, idx, arr) => !(c === "" && (idx === 0 || idx === arr.length - 1)));
    if (cells.length < 2) continue;

    // A numbered roster row starts with a bare integer (the spot number).
    if (!/^\d{1,3}$/.test(cells[0])) continue;
    const position = Number(cells[0]);

    const name = cleanName(cells[1] ?? "");
    if (!isPlausibleName(name)) continue;
    // A separator row (`| - | - |`) survives the cell filter but not this.
    if (/^-+$/.test(name)) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const detailRaw = cleanName(cells[2] ?? "");
    out.push({
      position,
      name,
      detail: detailRaw && isPlausibleName(detailRaw) ? detailRaw : null,
    });
    if (out.length >= MAX_ROSTER) break;
  }

  return out.length >= MIN_ROSTER ? out : [];
}

/**
 * OPE-405 — the roster in a piece of text, whatever shape it arrived in.
 *
 * Tries the bullet form first (the OPE-176 body-email case), then the markdown
 * table form (an OCR'd PDF placement list). One entry point so a caller cannot
 * accidentally support only the shape it happened to be written for — which is
 * exactly how the attachment half went missing for a year.
 */
export function detectRosterEntries(text: string | null | undefined): RosterEntry[] {
  if (!text) return [];
  const bulleted = detectRosterNames(text);
  if (bulleted.length > 0) {
    return bulleted.map((name) => ({ position: null, name, detail: null }));
  }
  return detectRosterTable(text);
}

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
