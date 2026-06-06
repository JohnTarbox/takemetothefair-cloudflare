#!/usr/bin/env tsx
/**
 * Verify that no Drizzle `db.select()` (bare, no projection) over a join
 * chain sums to more than D1's 100-column result-row cap.
 *
 * Usage:
 *   npx tsx scripts/check-d1-100col-joins.ts
 *
 * Exits 0 if every bare-`.select()` join is under the cap. Exits 1 with a
 * list of offenders (file + line + table list + column sum) otherwise.
 *
 * Background — 2026-06-06 prod incident
 * --------------------------------------
 * P3a's `drizzle/0112_venue_zone_locale_country.sql` added 3 columns to
 * `venues`. The vendor-detail page (`src/app/vendors/[slug]/page.tsx`) had
 * a bare `db.select().from(eventVendors).leftJoin(events).leftJoin(venues)`
 * that summed to 9 + 62 + 27 = 98 columns pre-P3a (just under D1's cap)
 * and 9 + 62 + 30 = 101 post-P3a. D1 silently returned zero rows when the
 * cap was exceeded → every vendor detail page rendered "Vendor Not Found"
 * for ~30 minutes until #357 narrowed the venues projection.
 *
 * PR #325's earlier 100-col audit only covered the events-detail join
 * (`eventJoinProjection`); the vendor-detail join wasn't in scope. This
 * script is the broader defense: every bare-`.select()` over N joined
 * tables gets its column sum checked, regardless of which page.
 *
 * Heuristic
 * ---------
 * 1. Parse `packages/db-schema/src/index.ts` for `export const X =
 *    sqliteTable("name", { col1: …, col2: … })` blocks; produce a
 *    {tableName → columnCount} map.
 * 2. Walk `src/` and `mcp-server/src/` for `.ts`/`.tsx` files.
 * 3. In each file, find every `db.select()\n  .from(<table>)` chain (bare
 *    select — no projection argument). For each such chain, collect every
 *    `.leftJoin(<table>` / `.innerJoin(<table>` / `.rightJoin(<table>`
 *    that follows it within the same statement (until the matching `;`).
 * 4. Sum the column counts. Report if sum > 100, warn if sum > 80.
 *
 * The heuristic intentionally over-matches a little — a bare `db.select()`
 * over a single table with 95 cols is "fine but tight," and the script
 * will emit a WARN for it. That's the desired behavior: any growth above
 * 80 columns is a signal worth seeing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const SCHEMA_PATH = resolve(ROOT, "packages/db-schema/src/index.ts");
const SCAN_DIRS = [resolve(ROOT, "src"), resolve(ROOT, "mcp-server/src")];
const ALLOWLIST_PATH = resolve(HERE, "check-d1-100col-joins.allowlist");

const HARD_LIMIT = 100;
const WARN_THRESHOLD = 80;

// ── Allowlist: files with known existing violations, scheduled for fix ───
//
// Adopting this check on a codebase with existing violations would mean a
// massive cleanup PR; instead the allowlist (one repo-relative path per
// line) suppresses the ERROR exit code for those files specifically. Each
// listed file should have a tracking issue / follow-up PR to narrow its
// projection. NEW violations on un-listed files still fail CI.
//
// Format: one `path` per line, optionally with `:<line>` to pin a specific
// occurrence. Lines starting with `#` are comments. Whitespace ignored.

interface AllowEntry {
  path: string;
  line?: number;
}

function loadAllowlist(): AllowEntry[] {
  try {
    const src = readFileSync(ALLOWLIST_PATH, "utf8");
    const out: AllowEntry[] = [];
    for (const raw of src.split("\n")) {
      const trimmed = raw.split("#")[0].trim();
      if (!trimmed) continue;
      const [path, lineStr] = trimmed.split(":");
      const entry: AllowEntry = { path };
      if (lineStr !== undefined) entry.line = parseInt(lineStr, 10);
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

function isAllowed(file: string, line: number, allowlist: AllowEntry[]): boolean {
  const rel = relative(ROOT, file);
  for (const entry of allowlist) {
    if (entry.path !== rel) continue;
    if (entry.line === undefined) return true; // whole-file allow
    if (entry.line === line) return true; // specific line
  }
  return false;
}

// ── 1) Parse canonical schema for column counts ──────────────────────────

function parseSchemaColumnCounts(schemaPath: string): Map<string, number> {
  const src = readFileSync(schemaPath, "utf8");
  const tables = new Map<string, number>();

  // Match `export const NAME = sqliteTable("dbname", {` and find the matching
  // closing brace of the column object. We use brace counting because the
  // columns can themselves contain nested braces (e.g. `text("x", { enum: ... })`).
  const startRe = /^export const (\w+) = sqliteTable\(\s*"[^"]+"\s*,\s*\{/gm;
  for (const match of src.matchAll(startRe)) {
    const name = match[1];
    const objStart = (match.index ?? 0) + match[0].length - 1; // position of "{"
    let i = objStart + 1;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const objEnd = i - 1; // position of matching "}"
    const objBody = src.slice(objStart + 1, objEnd);

    // Strip nested braces so we don't double-count keys inside option
    // objects like `text("status", { enum: ["A","B"] })`.
    let nested = 0;
    let cleaned = "";
    for (const c of objBody) {
      if (c === "{") nested++;
      else if (c === "}") nested--;
      else if (nested === 0) cleaned += c;
    }
    // Count `^\s+<identifier>:` lines (each is a column key).
    const colRe = /^\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/gm;
    let count = 0;
    for (const _ of cleaned.matchAll(colRe)) count++;
    tables.set(name, count);
  }

  return tables;
}

// ── 2) Walk source dirs ──────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

// ── 3) Find bare-select join chains ──────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  tables: string[];
  sum: number;
  level: "error" | "warn";
}

const BARE_SELECT_RE = /\bdb\s*\.\s*select\s*\(\s*\)/g;
const FROM_RE = /\.\s*from\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g;
const JOIN_RE = /\.\s*(?:left|inner|right|full)?Join\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g;

function findStatementEnd(src: string, start: number): number {
  // Scan forward for the next top-level `;` outside any nested ()/[]/{}.
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === ";" && depth === 0) {
      return i;
    }
  }
  return src.length;
}

function findViolations(file: string, tableColCounts: Map<string, number>): Violation[] {
  const src = readFileSync(file, "utf8");
  const out: Violation[] = [];

  for (const selectMatch of src.matchAll(BARE_SELECT_RE)) {
    const selectStart = selectMatch.index ?? 0;
    const end = findStatementEnd(src, selectStart + selectMatch[0].length);
    const chain = src.slice(selectStart, end);

    // Extract tables from .from(...) and .join(...) calls.
    const tables: string[] = [];
    for (const fm of chain.matchAll(FROM_RE)) tables.push(fm[1]);
    for (const jm of chain.matchAll(JOIN_RE)) tables.push(jm[1]);

    if (tables.length === 0) continue;

    let sum = 0;
    const tableLabels: string[] = [];
    for (const t of tables) {
      const n = tableColCounts.get(t);
      if (n !== undefined) {
        sum += n;
        tableLabels.push(`${t}(${n})`);
      } else {
        // Unknown table — keep in the label list as marker. We don't know if
        // it's an alias for a known table or a non-schema reference, so we
        // don't add to the sum.
        tableLabels.push(`${t}(?)`);
      }
    }

    const line = lineNumberAt(src, selectStart);
    if (sum > HARD_LIMIT) {
      out.push({ file, line, tables: tableLabels, sum, level: "error" });
    } else if (sum > WARN_THRESHOLD) {
      out.push({ file, line, tables: tableLabels, sum, level: "warn" });
    }
  }

  return out;
}

function lineNumberAt(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

// ── 4) Main ──────────────────────────────────────────────────────────────

function main() {
  const tableColCounts = parseSchemaColumnCounts(SCHEMA_PATH);
  if (tableColCounts.size === 0) {
    console.error(`Could not parse any tables from ${SCHEMA_PATH}`);
    process.exit(2);
  }
  console.log(`Parsed ${tableColCounts.size} tables from canonical schema.`);

  const allowlist = loadAllowlist();
  if (allowlist.length > 0) {
    console.log(`Loaded ${allowlist.length} allowlist entries.`);
  }

  const allViolations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    try {
      statSync(dir);
    } catch {
      continue;
    }
    const files = walk(dir);
    for (const file of files) {
      // Skip test files — they often use deliberately wide selects on small
      // in-memory fixture schemas.
      if (
        file.includes("__tests__") ||
        file.endsWith(".test.ts") ||
        file.endsWith(".test.tsx") ||
        file.endsWith(".spec.ts")
      ) {
        continue;
      }
      const violations = findViolations(file, tableColCounts);
      allViolations.push(...violations);
    }
  }

  // Partition: allowlist suppresses ERROR exit code but still emits a note.
  const allowedErrors: Violation[] = [];
  const newErrors: Violation[] = [];
  const allowedWarns: Violation[] = [];
  const newWarns: Violation[] = [];
  for (const v of allViolations) {
    const allowed = isAllowed(v.file, v.line, allowlist);
    if (v.level === "error") {
      (allowed ? allowedErrors : newErrors).push(v);
    } else {
      (allowed ? allowedWarns : newWarns).push(v);
    }
  }

  for (const v of newErrors) {
    const rel = relative(ROOT, v.file);
    console.error(
      `ERROR ${rel}:${v.line}  bare db.select() over ${v.tables.length} tables, sum=${v.sum} (>${HARD_LIMIT})`
    );
    console.error(`        tables: ${v.tables.join(" + ")}`);
    console.error(
      `        fix: replace bare .select() with .select({...}) narrowing one or more joined tables.`
    );
  }
  for (const v of newWarns) {
    const rel = relative(ROOT, v.file);
    console.warn(
      `WARN  ${rel}:${v.line}  bare db.select() over ${v.tables.length} tables, sum=${v.sum} (>${WARN_THRESHOLD})`
    );
    console.warn(`        tables: ${v.tables.join(" + ")}`);
  }

  // Summary of allowlisted violations — kept visible so the queue of
  // follow-ups is in front of every CI viewer.
  if (allowedErrors.length > 0 || allowedWarns.length > 0) {
    console.log(
      `\nAllowlisted (known, scheduled for fix): ${allowedErrors.length} error(s), ${allowedWarns.length} warning(s).`
    );
    for (const v of allowedErrors) {
      const rel = relative(ROOT, v.file);
      console.log(`  [allowed] ERROR ${rel}:${v.line}  sum=${v.sum}`);
    }
    for (const v of allowedWarns) {
      const rel = relative(ROOT, v.file);
      console.log(`  [allowed] WARN  ${rel}:${v.line}  sum=${v.sum}`);
    }
  }

  console.log(`\n${newErrors.length} new error(s), ${newWarns.length} new warning(s).`);
  if (newErrors.length > 0) {
    console.error(
      `\nD1 silently returns zero rows when a result row exceeds ${HARD_LIMIT} columns.`
    );
    console.error(`See memory feedback_d1_100_col_result_cap + PR #357 hotfix.`);
    console.error(
      `If this is intentional (e.g. you're explicitly narrowing the projection in a way the heuristic can't see), add the file to scripts/check-d1-100col-joins.allowlist.`
    );
    process.exit(1);
  }
}

main();
