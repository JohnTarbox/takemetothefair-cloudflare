#!/usr/bin/env tsx
/**
 * OPE-241 — refuse `inArray()` bind lists that grow with row count.
 *
 * Usage:
 *   npx tsx scripts/check-d1-inarray-params.ts
 *
 * Exits 0 when no unbounded site is found; exits 1 listing offenders otherwise.
 *
 * The ceiling
 * -----------
 * D1/SQLite caps a statement at 100 BOUND PARAMETERS. Confirmed against prod:
 *
 *     IN (…101 bound params…) → 7500 "too many SQL variables at offset 260"
 *     IN (…114 bound params…) → 7500 "too many SQL variables"
 *
 * So `inArray(col, xs)` where `xs.length` scales with row count is a latent
 * 500 that fires the day the table crosses ~100 rows. `blog_posts` crossed it
 * in June 2026 and `/admin/blog` threw in prod for weeks (OPE-79).
 *
 * NOTE this is a DIFFERENT ceiling from the 100-COLUMN result-row cap guarded
 * by check-d1-100col-joins.ts. Both are 100; they are unrelated limits.
 *
 * What counts as a violation
 * --------------------------
 * A site is flagged ONLY when the bind list provably scales with row count:
 * it traces back to a `db.select()` chain in the same file that has either no
 * `.limit(...)` at all, or a `.limit(N)` with N > 90.
 *
 * Why so narrow — precision over recall
 * ------------------------------------
 * There are ~135 `inArray` sites in this repo; only 16 were real bugs. A guard
 * that flagged all of them would be bulk-allowlisted within a week and would
 * then guard nothing. So anything this scanner cannot resolve is reported as
 * INFO and does NOT fail CI. It is a net for the known-bad shape, not a proof
 * of absence — a genuinely unbounded list built in a way the scanner can't
 * trace will pass. That is the deliberate trade.
 *
 * Recognised SAFE forms
 * ---------------------
 *   1. Inline literal array — `inArray(t.status, ["PENDING","DISPUTED"])`
 *   2. Inside `chunkedInArray(xs, (batch) => … inArray(col, batch) …)`
 *   3. Inside `for (const batch of chunkIds(xs))` / legacy `chunk(xs)`
 *   4. `const c = xs.slice(i, i + N)` → `inArray(col, c)`
 *   5. Upstream `.limit(N)` with N <= 90
 *   6. file (or file:line) listed in check-d1-inarray-params.allowlist
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCAN_DIRS = [resolve(ROOT, "src"), resolve(ROOT, "mcp-server/src")];
const ALLOWLIST_PATH = resolve(HERE, "check-d1-inarray-params.allowlist");

/** Must match D1_SAFE_IN_CHUNK in packages/utils/src/chunk-in-array.ts. */
const SAFE_CHUNK = 90;

interface Violation {
  file: string;
  line: number;
  arg: string;
  reason: string;
}

// ── allowlist (same format as check-d1-100col-joins.allowlist) ───────────

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

function isAllowed(relPath: string, line: number, allowlist: AllowEntry[]): boolean {
  for (const entry of allowlist) {
    if (entry.path !== relPath) continue;
    if (entry.line === undefined) return true;
    if (entry.line === line) return true;
  }
  return false;
}

// ── tiny source helpers ──────────────────────────────────────────────────

/** Walk forward from the index of a "(" and return the matching ")" index. */
function matchParen(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a call's argument text on top-level commas. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

const lineAt = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/**
 * Blank out comments and string bodies, preserving every byte offset and
 * newline so reported line numbers stay correct.
 *
 * Without this the scanner reads prose as code: `blog-coverage.ts` has a
 * comment explaining "we fetch with `inArray(page, blogUrls)` chunked at 90",
 * and the guard flagged that sentence as an unbounded call site. A guard that
 * reports comments as bugs gets ignored, so this is load-bearing.
 */
function blankNonCode(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "\\") k += 2;
        else if (src[k] === quote) break;
        else k++;
      }
      // Keep the quotes so literal-array detection still matches shape.
      blank(i + 1, k);
      i = Math.min(k + 1, src.length);
    } else {
      i++;
    }
  }
  return out.join("");
}

/** An array literal of only string/number/template constants. */
const LITERAL_ARRAY_RE = /^\[\s*(?:(?:"[^"]*"|'[^']*'|`[^`${}]*`|-?\d+(?:\.\d+)?)\s*,?\s*)*\]$/;

/**
 * True when `idx` sits inside a `chunkedInArray(...)` call — i.e. the
 * inArray is in the per-batch fetch callback, which is the sanctioned form.
 */
function insideChunkedInArray(src: string, idx: number): boolean {
  const re = /\bchunkedInArray\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close > idx && open < idx) return true;
  }
  return false;
}

/** `for (const X of chunkIds(...))` / `chunk(...)`, or `const X = y.slice(...)`. */
function isChunkVariable(src: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`for\\s*\\(\\s*const\\s+${esc}\\s+of\\s+(chunkIds|chunk)\\s*\\(`).test(src)) {
    return true;
  }
  if (new RegExp(`const\\s+${esc}\\s*=\\s*[\\w.]+\\.slice\\s*\\(`).test(src)) return true;
  return false;
}

/**
 * Given `name`, find its `const name = <expr>` binding and return <expr>.
 *
 * Resolves to the binding NEAREST BEFORE `useIdx`, not the first in the file:
 * names like `rows` / `ids` are reused across functions in these modules, and
 * matching the first occurrence resolved a limited query to an unrelated
 * unlimited one two functions away (a false positive on a correct `.limit(15)`).
 * Still scope-blind — good enough because the nearest preceding binding is
 * almost always the right one, and a wrong guess only costs a report, never a
 * silent pass (unresolvable → INFO, not ERROR).
 */
function findConstInit(src: string, name: string, useIdx: number = src.length): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\bconst\\s+${esc}\\s*(?::[^=]+)?=\\s*`, "g");
  let m: RegExpExecArray | null;
  let best: RegExpExecArray | null = null;
  while ((m = re.exec(src)) !== null) {
    if (m.index >= useIdx) break;
    best = m;
  }
  if (!best) return null;
  m = best;
  const start = m.index + m[0].length;
  // Read to the statement's end at depth 0.
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return src.slice(start, i);
      depth--;
    } else if (c === ";" && depth === 0) return src.slice(start, i);
  }
  return null;
}

/**
 * Pull the "root" identifier an expression is derived from:
 *   rows.map(r => r.id)                 → rows
 *   [...new Set(page.filter(..).map(..))] → page
 *   [...byType.event]                    → byType
 */
function rootIdentifier(expr: string): string | null {
  const m = /([A-Za-z_$][\w$]*)\s*(?:\.\s*(?:map|filter|flatMap|slice)\s*\()/.exec(expr);
  if (m) return m[1];
  const spread = /\[\s*\.\.\.\s*(?:new\s+Set\s*\(\s*)?([A-Za-z_$][\w$]*)/.exec(expr);
  if (spread) return spread[1];
  return null;
}

/**
 * Classify the select chain that produced `name`.
 *   "unbounded"    → a db.select() with no limit, or limit > SAFE_CHUNK
 *   "bounded"      → a db.select() with limit <= SAFE_CHUNK
 *   null           → not traceable to a select in this file
 */
function classifySelectSource(
  src: string,
  name: string,
  useIdx: number
): { verdict: string; detail: string } | null {
  const init = findConstInit(src, name, useIdx);
  if (init === null) return null;
  if (!/\bdb\s*\n?\s*\.\s*select\b|\.\s*select\s*\(/.test(init)) return null;

  if (!/\.limit\s*\(/.test(init)) {
    return {
      verdict: "unbounded",
      detail: `\`${name}\` comes from a db.select() with no .limit()`,
    };
  }
  // A limit whose argument isn't a plain integer (e.g. `.limit(params.limit ?? 20)`)
  // can't be proven safe OR unsafe from the source alone — the real ceiling lives
  // in the caller's zod schema. Report, don't enforce: guessing "unbounded" here
  // produced a false positive on a correctly-capped query.
  const literalLimit = /\.limit\s*\(\s*(\d+)\s*\)/.exec(init);
  if (!literalLimit) return null;

  const n = parseInt(literalLimit[1], 10);
  if (n > SAFE_CHUNK) {
    return {
      verdict: "unbounded",
      detail: `\`${name}\` comes from a db.select().limit(${n}) — above the ${SAFE_CHUNK} safe chunk`,
    };
  }
  return { verdict: "bounded", detail: `.limit(${n})` };
}

// ── scan one file ────────────────────────────────────────────────────────

function findViolations(
  relPath: string,
  src: string
): { violations: Violation[]; unresolved: number } {
  const violations: Violation[] = [];
  let unresolved = 0;

  const re = /\binArray\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = splitArgs(src.slice(open + 1, close));
    if (args.length < 2) continue;
    const arg = args[1].replace(/\s+/g, " ").trim();
    const line = lineAt(src, m.index);

    // 1. Inline literal array — bounded by construction.
    if (LITERAL_ARRAY_RE.test(arg)) continue;

    // 2. Inside the sanctioned chunkedInArray(...) fetch callback.
    if (insideChunkedInArray(src, m.index)) continue;

    // Strip a trailing cast (`ids as Slug[]`) before identifier analysis.
    const bare = arg.replace(/\s+as\s+[\w[\]<>. |]+$/, "").trim();

    // 3/4. A chunk-loop variable or an explicit .slice() batch.
    if (/^[A-Za-z_$][\w$]*$/.test(bare) && isChunkVariable(src, bare)) continue;

    // Resolve the source the list is derived from.
    let source: string | null = null;
    if (/^[A-Za-z_$][\w$]*$/.test(bare)) {
      const init = findConstInit(src, bare, m.index);
      source = init ? (rootIdentifier(init) ?? bare) : bare;
      // `const ids = rows.map(...)` → analyse `rows`; else analyse the name itself.
      if (init && rootIdentifier(init) === null) source = bare;
    } else {
      // Inline expression, e.g. `rows.map(r => r.id)`.
      source = rootIdentifier(bare);
    }
    if (!source) {
      unresolved++;
      continue;
    }

    // A chunk variable reached indirectly still counts as safe.
    if (isChunkVariable(src, source)) continue;

    const cls = classifySelectSource(src, source, m.index);
    if (cls === null) {
      unresolved++;
      continue;
    }
    if (cls.verdict === "unbounded") {
      violations.push({ file: relPath, line, arg, reason: cls.detail });
    }
  }
  return { violations, unresolved };
}

// ── walk ─────────────────────────────────────────────────────────────────

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry) && !full.includes("__tests__")) yield full;
  }
}

function main() {
  const allowlist = loadAllowlist();
  const all: Violation[] = [];
  let unresolvedTotal = 0;
  let scanned = 0;

  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const raw = readFileSync(file, "utf8");
      if (!raw.includes("inArray(")) continue;
      // Comments/string bodies blanked (offsets preserved) so prose describing
      // an inArray call isn't mistaken for one.
      const src = blankNonCode(raw);
      if (!src.includes("inArray(")) continue;
      scanned++;
      const rel = relative(ROOT, file);
      const { violations, unresolved } = findViolations(rel, src);
      all.push(...violations);
      unresolvedTotal += unresolved;
    }
  }

  const allowed = all.filter((v) => isAllowed(v.file, v.line, allowlist));
  const fresh = all.filter((v) => !isAllowed(v.file, v.line, allowlist));

  for (const v of fresh) {
    console.error(`ERROR ${v.file}:${v.line}  unbounded inArray bind list: ${v.arg}`);
    console.error(`        ${v.reason}`);
    console.error(
      `        fix: chunkedInArray(xs, (batch) => db.select()…where(inArray(col, batch)))  [reads]`
    );
    console.error(
      `             for (const batch of chunkIds(xs)) { … }                        [writes]`
    );
    console.error(`        both from @takemetothefair/utils`);
  }

  // Kept visible on every run so the accepted-risk list stays in front of
  // reviewers rather than rotting silently in a file nobody opens.
  if (allowed.length > 0) {
    console.log(
      `\nAllowlisted (see scripts/check-d1-inarray-params.allowlist for why each is safe): ${allowed.length}`
    );
    for (const v of allowed) console.log(`  [allowed] ${v.file}:${v.line}  ${v.arg}`);
  }

  console.log(
    `\nScanned ${scanned} file(s) containing inArray. ${fresh.length} new error(s); ` +
      `${unresolvedTotal} site(s) not statically resolvable (reported, not enforced).`
  );

  if (fresh.length > 0) {
    console.error(
      `\nD1 rejects a statement with >100 bound parameters ("too many SQL variables").`
    );
    console.error(
      `An inArray list that grows with row count is a latent 500 — see OPE-79 (/admin/blog).`
    );
    console.error(
      `If a flagged site is genuinely safe, add it to scripts/check-d1-inarray-params.allowlist with a reason.`
    );
    process.exit(1);
  }
}

main();
