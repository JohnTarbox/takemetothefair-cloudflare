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

/**
 * OPE-405 rework — generic form-field labels, which are NOT exhibitors.
 *
 * A blank vendor APPLICATION form OCRs into exactly the shape a roster has: a
 * roster-keyword heading followed by a bulleted list. The list is the fields
 * you are asked to fill in. Prod `4c536723` staged "Name", "Phone Number",
 * "Mailing Address", "Email Address", "Business Name" as its exhibitor roster.
 */
const FORM_FIELD_LABELS = new Set([
  "name",
  "full name",
  "first name",
  "last name",
  "business name",
  "company name",
  "contact name",
  "phone",
  "phone number",
  "telephone",
  "cell",
  "email",
  "e-mail",
  "email address",
  "address",
  "mailing address",
  "street address",
  "city",
  "state",
  "zip",
  "zip code",
  "website",
  "signature",
  "date",
  "amount",
  "fee",
  "total",
  "product description",
  "description",
  "type of work",
  "booth size",
  "notes",
]);

function isPlausibleName(s: string): boolean {
  if (s.length === 0 || s.length > MAX_NAME_LEN) return false;
  if (s.split(/\s+/).length > MAX_NAME_WORDS) return false; // reject prose
  if (!/[A-Za-z0-9]/.test(s)) return false; // must carry a letter/number

  // ── OPE-405 rework — precision gate ──────────────────────────────────────
  //
  // Measured in prod 2026-08-20: roster detection had fired THREE times and
  // produced **zero real exhibitor names**. Every staged roster was junk, and
  // each one set `flagged_for_review=1`, sending an operator to look at
  // nothing. That is worse than the silent no-op it was filed as, because it
  // looks like coverage.
  //
  //   34b06089  "Peripheral Rows:", "Top-right:** Stalls 21, 22, 35, 36, and
  //             31.", "Miscellaneous:"  ← a vision model DESCRIBING a booth map
  //   4c536723  "Name", "Phone Number", "Email Address", "Business Name"
  //             ← a blank application FORM
  //   ac46add3  "Artisan Stalls:"
  //
  // The common cause: OCR of an image is a *description*, not a transcription.
  // It renders structure as `**Label:** value` bullets under a heading, and
  // `artisans?` in ROSTER_KEYWORD matches "Artisan Stalls:", so the heading
  // gate passes. Nothing downstream asked whether the bullets were names.

  // A heading or a field label, never an exhibitor: "Peripheral Rows:".
  if (s.endsWith(":")) return false;

  // Residual markdown emphasis means this line was `**Label:** value` — a
  // described structure, not a name. cleanName only strips the ENDS.
  if (s.includes("**")) return false;

  if (FORM_FIELD_LABELS.has(s.toLowerCase())) return false;

  // A sentence, not a name: "Stalls 32, 33, and 34." Gated on word count so a
  // legitimate "Smith & Sons Inc." (4 words) still passes.
  if (s.endsWith(".") && s.split(/\s+/).length > 4) return false;

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
        // Counted BEFORE dedup, and it is not the same number as `names.length`.
        // See the gate below for why the difference matters.
        let plausibleCount = 0;
        for (let k = i; k < j && names.length < MAX_ROSTER; k++) {
          const m = lines[k].match(BULLET);
          if (!m) continue;
          const name = cleanName(m[1]);
          if (!isPlausibleName(name)) continue;
          plausibleCount++;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          names.push(name);
        }
        // OPE-405 rework — the MIN_ROSTER gate now applies to the SURVIVORS,
        // not just the raw run.
        //
        // This deliberately reverses an earlier decision. Gating on run length
        // alone was defensible while the filter only removed duplicates and
        // obvious prose: the run itself was the "list under a vendor heading"
        // signal. It stopped being defensible once the precision gate began
        // rejecting headings and form-field labels, because a run of four
        // structural bullets with a single name-shaped token among them would
        // stage a one-entry "roster" — and every staged roster sets
        // `flagged_for_review=1`, so the cost lands on an operator.
        //
        // The count that matters is PLAUSIBLE entries, not surviving unique
        // ones, because the two drops mean opposite things:
        //
        //   rejected as implausible  → evidence this is NOT a roster (a
        //                              heading, a form-field label, prose)
        //   dropped as a duplicate   → still evidence it IS one; the run held
        //                              three roster-shaped items, two of which
        //                              named the same vendor
        //
        // Gating on `names.length` would have killed a legitimate three-item
        // list containing one case-duplicate — which is exactly what the
        // existing "dedupes case-insensitively" test covers, and why that test
        // is load-bearing rather than incidental.
        if (plausibleCount >= MIN_ROSTER) return names;
      }
    }
    i = j;
  }
  return [];
}
