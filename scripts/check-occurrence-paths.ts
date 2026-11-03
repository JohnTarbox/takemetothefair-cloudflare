#!/usr/bin/env tsx
/**
 * Guard (OPE-1324): occurrence URLs are built and parsed in ONE place —
 * `packages/utils/src/edition-path.ts`.
 *
 * The rule `/events/<series>/<UTC year>` used to be written by hand in ~11
 * builders and 5 parsers across the app and the MCP Worker. Multi-edition series
 * (OPE-1315 option A) widen that segment; with the rule copied, one missed copy
 * silently sends a second edition's links, canonical or redirect to the first —
 * and nothing errors. This fails CI on a new hand-written copy:
 *
 *   1. a template literal building `/events/${…}/${…}`;
 *   2. `getUTCFullYear` in a file that also handles a series slug
 *      (`canonicalSlug` / `seriesSlug`) — the year half of the same rule;
 *   3. a `/^\d{4}$/` year-segment regex in a file that handles `/events/` paths.
 *
 * ⚠️ Files are read with Node, NOT grep: three files in this repo
 * (group-events.ts, report-client-error.ts, promoter-rule-agreement.ts) contain
 * a NUL byte, and grep treats them as binary and prints no matches — an audit
 * done with grep is blind to them. The test plants a violation in a NUL-byte
 * file to keep that true.
 *
 * Usage: npx tsx scripts/check-occurrence-paths.ts   (exit 0 clean, 1 offenders)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The one file allowed to write the rule. */
export const OCCURRENCE_PATH_HOME = "packages/utils/src/edition-path.ts";

/**
 * Other URL families that share the `/events/<a>/<b>` shape on purpose, each
 * with the reason. Keep this list short and specific.
 */
export const ALLOWED: Readonly<Record<string, string>> = {
  // /events/<state>/<facet> — the state-facet browse routes, not occurrences.
  "src/lib/events/facets.ts": "state facet route /events/<state>/<facet>",
  "src/components/events/facet-nav.tsx": "state facet route /events/<state>/<facet>",
  "src/components/events/state-facet-page.tsx": "state facet route /events/<state>/<facet>",
  // "years at this venue" display range from first/last event — not a URL.
  "src/lib/venues/venue-history-public.ts": "venue tenure year range (display only)",
};

const TEMPLATE_RE = /\/events\/\$\{[^}]+\}\/\$\{/;
const UTC_YEAR_RE = /getUTCFullYear/;
const SERIES_SLUG_RE = /\b(canonicalSlug|seriesSlug)\b/;
const YEAR_SEGMENT_RE = /\/\^\\d\{4\}\$\//;
const EVENTS_PATH_RE = /\/events\//;

export interface Offence {
  file: string;
  line: number;
  rule: "template" | "utc-year" | "year-regex";
  text: string;
}

/** Scan one file's text. `rel` is the repo-relative path. */
export function scanSource(rel: string, src: string): Offence[] {
  if (rel === OCCURRENCE_PATH_HOME || ALLOWED[rel]) return [];
  const out: Offence[] = [];
  const handlesSeries = SERIES_SLUG_RE.test(src);
  const handlesEventsPaths = EVENTS_PATH_RE.test(src);
  src.split("\n").forEach((line, i) => {
    // An API path (`/api/admin/events/${id}/${action}`) is not an event page.
    if (TEMPLATE_RE.test(line) && !line.includes("/api/")) {
      out.push({ file: rel, line: i + 1, rule: "template", text: line.trim() });
    }
    if (handlesSeries && UTC_YEAR_RE.test(line)) {
      out.push({ file: rel, line: i + 1, rule: "utc-year", text: line.trim() });
    }
    if (handlesEventsPaths && YEAR_SEGMENT_RE.test(line)) {
      out.push({ file: rel, line: i + 1, rule: "year-regex", text: line.trim() });
    }
  });
  return out;
}

const SCAN_ROOTS = ["src", "mcp-server/src", "packages"];
const SKIP_DIRS = new Set(["node_modules", "__tests__", "dist", ".next", ".open-next"]);
const EXTS = /\.(ts|tsx)$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
}

export function scanRepo(root: string): { files: number; offences: Offence[] } {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) {
    try {
      walk(resolve(root, r), files);
    } catch {
      /* a root that does not exist in this checkout */
    }
  }
  const offences = files.flatMap((f) =>
    // Node reads NUL bytes as ordinary characters — unlike grep.
    scanSource(relative(root, f).split("\\").join("/"), readFileSync(f, "utf8"))
  );
  return { files: files.length, offences };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { files, offences } = scanRepo(root);
  if (offences.length === 0) {
    console.log(
      `OK ${files} files scanned; occurrence URLs are built only in ${OCCURRENCE_PATH_HOME}.`
    );
    process.exit(0);
  }
  console.error(`Hand-built occurrence URL logic in ${offences.length} place(s):\n`);
  for (const o of offences) console.error(`  - ${o.file}:${o.line} [${o.rule}] ${o.text}`);
  console.error(
    `\nUse the helpers in ${OCCURRENCE_PATH_HOME} (occurrencePath, seriesOccurrencePath,\n` +
      "eventCanonicalPath, occurrenceYear, parseOccurrenceSegment, pickOccurrenceForYear).\n" +
      "A genuinely different URL family goes in ALLOWED in this script, with its reason."
  );
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
