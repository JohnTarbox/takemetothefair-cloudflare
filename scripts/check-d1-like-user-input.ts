#!/usr/bin/env tsx
/**
 * OPE-565 — refuse a LIKE/GLOB pattern built from user input.
 *
 * Usage:
 *   npx tsx scripts/check-d1-like-user-input.ts
 *
 * Exits 0 when no tainted site is found; exits 1 listing offenders otherwise.
 *
 * The ceiling
 * -----------
 * D1/SQLite caps LIKE/GLOB **pattern complexity**, and a pattern that grows
 * with user input eventually crosses it:
 *
 *     D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
 *
 * 315 occurrences across five call sites in 27 days (2026-07-29 → 08-26). It
 * is the THIRD distinct D1 limit this repo has shipped a production outage
 * against, after:
 *
 *     100 COLUMNS in a result row  → check-d1-100col-joins.ts   (OPE-26/70)
 *     100 BOUND PARAMETERS         → check-d1-inarray-params.ts (OPE-79/241)
 *     LIKE pattern complexity      → this guard                 (OPE-548/565)
 *
 * All three are unrelated limits that happen to bite the same way. OPE-79
 * fixed one bind-param call site and shipped no guard; the family recurred.
 * That is the precedent this exists to break.
 *
 * The fix, not just the ban
 * -------------------------
 * Use `containsCI(col, needle)` from `src/lib/db/contains-ci.ts`. It compiles
 * to `instr(lower(col), ?) > 0`, which has NO pattern-complexity ceiling —
 * so the error class is removed rather than pushed further out. It is also
 * more correct: `%` and `_` are literal to instr(), so a visitor searching for
 * "100% off" finds that text instead of matching two wildcards.
 *
 * ⚠️ `sanitizeLikeInput` is NOT a fix and is flagged wherever it appears.
 * It REPLACES `%` with `\%` — an escape that only works alongside an `ESCAPE`
 * clause, which Drizzle's `like()` cannot emit. The wildcard therefore survived
 * into the pattern AND the pattern got longer. Every call site that used it
 * read as guarded and was not.
 *
 * What counts as a violation — precision over recall
 * --------------------------------------------------
 * There are ~50 LIKE sites in this repo and only a handful take user input;
 * the rest interpolate category constants, a HOST prefix, or a denylist. A
 * guard that flagged all of them would be bulk-allowlisted within a week and
 * would then guard nothing — the explicit lesson from
 * check-d1-inarray-params.ts. So a site is flagged ONLY when both hold:
 *
 *   1. the LIKE pattern interpolates an expression, AND
 *   2. that expression traces to a REQUEST source in the same file —
 *      `searchParams`, `params.get(...)`, `request.json()`, `formData.get(...)`,
 *      or an identifier assigned from one of those.
 *
 * Anything it cannot resolve is silent. This is a net for the known-bad shape,
 * not a proof of absence.
 *
 * Recognised SAFE forms
 * ---------------------
 *   1. A literal pattern — like(t.slug, "%-merged-%")
 *   2. Interpolating a module constant or a loop var over one —
 *      PRODUCER_CLASS_CATEGORIES.map((c) => like(t.categories, `%"${c}"%`))
 *   3. Interpolating a value derived from a DB row rather than a request
 *   4. file (or file:line) listed in check-d1-like-user-input.allowlist
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src", "mcp-server/src", "packages"];
const SKIP = ["node_modules", ".next", ".open-next", "dist", "__tests__", ".git"];

const ALLOWLIST_PATH = join(ROOT, "scripts", "check-d1-like-user-input.allowlist");

/** Assignments that make an identifier user-controlled. */
const REQUEST_SOURCE =
  /\b(searchParams|nextUrl\.searchParams|url\.searchParams)\b|\.get\(\s*["'][\w-]+["']\s*\)|await\s+(request|req)\.(json|formData|text)\(\)/;

/** A LIKE/GLOB pattern site with something interpolated into the pattern. */
const LIKE_SITE = /\b(?:not)?[Ll]ike\s*\(|\bLIKE\s|\bGLOB\s/;

interface Violation {
  file: string;
  line: number;
  text: string;
  why: string;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.includes(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function loadAllowlist(): Set<string> {
  try {
    return new Set(
      readFileSync(ALLOWLIST_PATH, "utf8")
        .split("\n")
        .map((l) => l.split("#")[0].trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

/**
 * Identifiers in this file that hold request-derived values.
 *
 * Deliberately file-local and syntactic. A value laundered through a helper in
 * another module is not traced — see the precision note in the header.
 */
function taintedIdentifiers(lines: string[]): Set<string> {
  const tainted = new Set<string>();
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith("//") || l.startsWith("*")) continue;
    if (!REQUEST_SOURCE.test(l)) continue;

    // const q = searchParams.get("q")  /  const { query } = await req.json()
    const single = l.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (single) tainted.add(single[1]);
    const destructured = l.match(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=/);
    if (destructured) {
      for (const part of destructured[1].split(",")) {
        const name = part.split(":").pop()!.split("=")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) tainted.add(name);
      }
    }
  }
  return tainted;
}

/** Expressions interpolated into a LIKE pattern on this line. */
function interpolations(line: string): string[] {
  const out: string[] = [];
  const re = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1].trim());
  // `"%" + q + "%"` concatenation form
  const concat = line.match(/["']%["']\s*\+\s*([A-Za-z_$][\w$.()]*)/g);
  if (concat) for (const c of concat) out.push(c.replace(/^["']%["']\s*\+\s*/, "").trim());
  return out;
}

/**
 * Pure per-file scan. Exported so unit tests can exercise it against synthetic
 * source with no filesystem and no process.exit — the convention
 * check-turnstile-params.ts established.
 */
export function checkFile(rel: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const tainted = taintedIdentifiers(lines);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    const lineNo = i + 1;
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;

    let why = "";
    // sanitizeLikeInput is never a fix — flag its use anywhere but its own
    // definition and the guard's own source.
    if (
      line.includes("sanitizeLikeInput(") &&
      !rel.endsWith("src/lib/utils.ts") &&
      !rel.startsWith("scripts/")
    ) {
      why =
        "uses sanitizeLikeInput, which escapes rather than strips and needs an ESCAPE clause nothing emits";
    } else if (LIKE_SITE.test(line)) {
      const hit = interpolations(line).find((expr) => {
        if (REQUEST_SOURCE.test(expr)) return true;
        const ident = expr.match(/^([A-Za-z_$][\w$]*)/)?.[1];
        return !!ident && tainted.has(ident);
      });
      if (hit) why = `LIKE pattern interpolates request-derived \`${hit}\``;
    }
    if (!why) return;
    out.push({ file: rel, line: lineNo, text: line.slice(0, 130), why });
  });
  return out;
}

function main(): void {
  const allow = loadAllowlist();
  const violations: Violation[] = [];
  const allowed: Violation[] = [];
  let scanned = 0;

  for (const dir of SCAN_DIRS) {
    for (const abs of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      const src = readFileSync(abs, "utf8");
      if (!LIKE_SITE.test(src) && !src.includes("sanitizeLikeInput")) continue;
      scanned++;
      for (const v of checkFile(rel, src)) {
        if (allow.has(v.file) || allow.has(`${v.file}:${v.line}`)) allowed.push(v);
        else violations.push(v);
      }
    }
  }

  for (const v of violations) {
    console.error(`✗ ${v.file}:${v.line}\n    ${v.text}\n    → ${v.why}`);
  }
  if (allowed.length > 0) {
    console.log(
      `\nAllowlisted (see scripts/check-d1-like-user-input.allowlist for why each is safe): ${allowed.length}`
    );
    for (const v of allowed) console.log(`  [allowed] ${v.file}:${v.line}`);
  }

  console.log(
    `\nScanned ${scanned} file(s) containing a LIKE/GLOB site. ${violations.length} error(s).`
  );

  if (violations.length > 0) {
    console.error(`\nD1 caps LIKE/GLOB pattern complexity ("LIKE or GLOB pattern too complex").`);
    console.error(
      `A pattern built from user input is a latent 500 — 315 occurrences across 5 call sites in 27 days (OPE-548/565).`
    );
    console.error(
      `Fix: use containsCI(col, needle) from @/lib/db/contains-ci — instr(), which has no pattern ceiling.`
    );
    console.error(
      `If a flagged site is genuinely safe, add it to scripts/check-d1-like-user-input.allowlist with a reason.`
    );
    process.exit(1);
  }
}

// Run as a script, but stay importable for unit tests (which exercise checkFile).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
