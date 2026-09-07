/**
 * OPE-837 — rosters printed as an INLINE COMMA RUN.
 *
 * ## Why a third roster shape
 *
 * `detectRosterEntries` (mcp-server/src/email-handlers/roster-detect.ts)
 * already handles the two shapes rosters arrive in by EMAIL: a bullet list
 * (OPE-176) and a markdown table from an OCR'd PDF placement list (OPE-405).
 * Neither matches the shape a roster takes on a WEB PAGE, which is prose:
 *
 *   2026 Artisan Vendors (to-date): 27 North, Afterglow Ice Cream,
 *   Barters Island Bees, Inc, Bryant's Brewing, Chef Paul's, ...
 *
 * Measured on the specimen, this shape carries 63 exhibitors across three
 * pages (34 artisan vendors + 21 cheesemakers + 8 food trucks) and the two
 * existing detectors return zero from all three.
 *
 * ## The trap
 *
 * The separator is a comma and so is part of several NAMES: "Barters Island
 * Bees, Inc" and "Dogpatch Farm, LLC" are one exhibitor each, not two. A naive
 * `split(",")` inflates the roster with fragments like "Inc" and "LLC" — which
 * would then be handed to `create_or_link_vendor` and mint junk vendor rows.
 * Re-joining a bare legal suffix onto its predecessor is the whole reason this
 * is a parser rather than a one-liner.
 *
 * Pure — no I/O.
 */

/** A roster cue: a heading-ish label immediately followed by the run. */
const ROSTER_CUE =
  /(?:\b(?:20\d{2}\s+)?(?:festival\s+)?(?:artisan\s+vendors?|cheesemakers?(?:\s+vendors?)?|food\s+truck\s+vendors?|food\s+trucks?|craft(?:er)?s?|exhibitors?|artisans?|makers?|vendors?|participants?|line\s*-?\s*up)\b[^:\n]{0,40}:)/i;

/**
 * Where a comma run stops.
 *
 * The run is followed by ordinary prose on every real page ("Contact us at…",
 * "Applications are due…", the footer). Without a terminator the parser walks
 * off the end of the list and turns whole sentences into "names".
 */
const RUN_TERMINATOR =
  /(?:\.\s|\?\s|!\s|\n\n)|(?:\b(?:contact\s+us|applications?\s+(?:are|due)|for\s+more\s+information|open\s+facebook|open\s+instagram|©|copyright|whenever\s+possible|the\s+\w+\s+planning\s+committee)\b)/i;

/** A fragment that is a bare legal suffix, i.e. the tail of the PREVIOUS name. */
const LEGAL_SUFFIX = /^(?:inc|llc|l\.l\.c|ltd|co|corp|company|pllc|lp|llp)\.?$/i;

/** Maximum names taken from one page — a guard against a runaway match. */
const MAX_NAMES = 400;
/** Below this a "list" is more likely a sentence with commas in it. */
const MIN_NAMES = 3;

/** Obvious non-names that survive splitting on a sloppy page. */
const NOT_A_NAME =
  /^(?:and|or|more|tbd|tba|etc|others?|many\s+more|coming\s+soon|to\s+be\s+announced|see\s+below)$/i;

function cleanName(raw: string): string {
  let s = raw.trim();
  // Leading conjunction from the final "…, and Whey North Creamery" item.
  s = s.replace(/^(?:and|&)\s+/i, "");
  // Leading list punctuation / bullets that survive HTML stripping.
  s = s.replace(/^[-–—•*· \s]+/, "");
  // A trailing period ends the SENTENCE, not the name — unless the name's last
  // token is an abbreviation that owns it ("Sojourn Ice Co." keeps its dot).
  if (s.endsWith(".")) {
    const lastToken = s.slice(0, -1).split(/\s+/).pop() ?? "";
    if (!LEGAL_SUFFIX.test(lastToken)) s = s.slice(0, -1);
  }
  return s.replace(/\s+/g, " ").trim();
}

function isPlausible(name: string): boolean {
  if (name.length < 2 || name.length > 80) return false;
  if (NOT_A_NAME.test(name)) return false;
  // Must contain a letter — "2026" or "&" alone is not an exhibitor.
  if (!/[a-z]/i.test(name)) return false;
  // A run of many words is a sentence that escaped the terminator.
  if (name.split(/\s+/).length > 9) return false;
  return true;
}

/**
 * Split one comma run into names, re-joining bare legal suffixes.
 *
 * Exported for direct testing: the re-join rule is the part most likely to
 * regress, and it is easier to pin here than through a full page.
 */
export function splitRosterRun(run: string): string[] {
  const parts = run.split(",");
  const joined: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (joined.length > 0 && LEGAL_SUFFIX.test(trimmed)) {
      // "Barters Island Bees" + ", Inc" — one exhibitor, not two.
      joined[joined.length - 1] = `${joined[joined.length - 1]}, ${trimmed}`;
      continue;
    }
    joined.push(trimmed);
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const candidate of joined) {
    const name = cleanName(candidate);
    if (!isPlausible(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_NAMES) break;
  }
  return names;
}

/**
 * Extract an inline comma-separated roster from page text.
 *
 * Returns `[]` unless a roster cue is found AND the run yields at least
 * `MIN_NAMES` plausible names — so ordinary prose containing a comma cannot
 * be mistaken for a roster.
 */
export function extractInlineRoster(text: string | null | undefined): string[] {
  if (!text) return [];
  const flat = text.replace(/\r/g, "");

  const all: string[] = [];
  const seen = new Set<string>();
  // A page can carry more than one cue ("Cheesemakers:" and "Food Trucks:").
  let cursor = 0;
  let guard = 0;
  while (cursor < flat.length && guard++ < 20) {
    const slice = flat.slice(cursor);
    const cue = ROSTER_CUE.exec(slice);
    if (!cue) break;
    const runStart = cursor + cue.index + cue[0].length;
    const rest = flat.slice(runStart);
    const stop = RUN_TERMINATOR.exec(rest);
    const run = stop ? rest.slice(0, stop.index) : rest.slice(0, 4000);
    const names = splitRosterRun(run);
    if (names.length >= MIN_NAMES) {
      for (const n of names) {
        const key = n.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(n);
      }
    }
    cursor = runStart + Math.max(run.length, 1);
  }

  return all.slice(0, MAX_NAMES);
}
