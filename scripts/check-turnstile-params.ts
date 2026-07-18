#!/usr/bin/env tsx
/**
 * OPE-250 — guard Cloudflare Turnstile render params so a registration-blocking
 * misconfiguration can't ship a THIRD time.
 *
 * Usage:  npx tsx scripts/check-turnstile-params.ts   (exit 1 on any violation)
 *
 * Two Urgent regressions in one week, both blocking ALL signups:
 *   - OPE-150 (2026-07-09): NEXT_PUBLIC_TURNSTILE_SITE_KEY empty in the build —
 *     widget never mounted.
 *   - OPE-173 (2026-07-11): the fix passed `size: "invisible"` — not a legal
 *     explicit-render size ({normal, compact, flexible} only) — so the widget
 *     threw TurnstileError at init. 122+ client errors.
 *
 * OPE-173's own write-up recommended exactly this guard; it was never filed.
 * This scanner is the durable prevention (mirrors scripts/check-d1-inarray-params.ts).
 *
 * What it checks, on every file that mounts Turnstile (references
 * `turnstile.render(` or declares a Turnstile options interface):
 *
 *   1. SIZE VALUE — any `size: "<lit>"` passed to a render-options object must
 *      be in the allowed set. Catches the OPE-173 `size: "invisible"` shape.
 *   2. SIZE TYPE — any `size?: <type>` annotation must be a union of ONLY the
 *      allowed string literals, never a bare `string`/`any`. This is the
 *      durable catch: the current code is safe *because* both mounts type the
 *      union tightly; widening it to `string` would silently reopen the door.
 *   3. SITEKEY SOURCE — the file must reference NEXT_PUBLIC_TURNSTILE_SITE_KEY
 *      (the OPE-150 class, to the extent statically checkable) and must not pass
 *      an empty `sitekey: ""` literal.
 *
 * It also enumerates the KNOWN mounts and warns (does not fail) when a new
 * Turnstile-mounting file appears that isn't listed — a nudge to give the new
 * mount a human look and add it here.
 *
 * Table-driven: extend ALLOWED_SIZES (or the checks) as Turnstile grows params.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCAN_DIRS = [resolve(ROOT, "src")];

/** The ONLY legal explicit-render sizes. "invisible" is NOT one — invisible /
 *  managed behavior is configured on the sitekey in the Cloudflare dashboard,
 *  never as a render `size` (OPE-173). */
const ALLOWED_SIZES = new Set(["normal", "compact", "flexible"]);

/** The public env var every mount must source its sitekey from (OPE-150). */
const SITEKEY_ENV = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";

/** Known, reviewed Turnstile mounts. A new one triggers a WARN so it gets eyes. */
const KNOWN_MOUNTS = new Set([
  "src/app/(auth)/register/page.tsx",
  "src/app/suggest-event/page.tsx",
]);

interface Violation {
  file: string;
  line: number;
  message: string;
}

const lineAt = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/** Every double/single/back-quoted string literal in a snippet. */
function stringLiterals(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

function isTurnstileFile(src: string): boolean {
  return /turnstile\.render\s*\(/.test(src) || /interface\s+TurnstileOptions\b/.test(src);
}

export function checkFile(relPath: string, src: string): Violation[] {
  const violations: Violation[] = [];

  // ── 1 & 2. every `size:` / `size?:` occurrence ──
  // RHS is read up to the first line-terminating delimiter. `size?:` (optional)
  // is always a TYPE annotation; bare `size:` in an object literal is a VALUE.
  const sizeRe = /\bsize(\??)\s*:\s*([^,;}\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = sizeRe.exec(src)) !== null) {
    const isTypeAnnotation = m[1] === "?";
    const rhs = m[2].trim();
    const line = lineAt(src, m.index);
    const literals = stringLiterals(rhs);

    // A widened type (`size?: string` / `: any`) is the silent-regression shape.
    if (isTypeAnnotation && literals.length === 0) {
      violations.push({
        file: relPath,
        line,
        message: `Turnstile \`size\` type is \`${rhs}\` — widen-to-string reopens the OPE-173 hole. Type it as a union of ${[...ALLOWED_SIZES].map((s) => `"${s}"`).join(" | ")}.`,
      });
      continue;
    }
    // Every string literal (a value, or every member of a union type) must be legal.
    for (const lit of literals) {
      if (!ALLOWED_SIZES.has(lit)) {
        violations.push({
          file: relPath,
          line,
          message: `Turnstile \`size: "${lit}"\` is not a legal explicit-render size (OPE-173). Allowed: ${[...ALLOWED_SIZES].join(", ")}. "invisible"/managed is set on the sitekey in the dashboard, not as a size.`,
        });
      }
    }
  }

  // ── 3. sitekey source ──
  if (!src.includes(SITEKEY_ENV)) {
    violations.push({
      file: relPath,
      line: 1,
      message: `Turnstile mount does not reference ${SITEKEY_ENV} — the sitekey must come from that public env var (OPE-150), or the widget never mounts and every signup is blocked.`,
    });
  }
  const emptySitekey = /\bsitekey\s*:\s*(""|''|``)/.exec(src);
  if (emptySitekey) {
    violations.push({
      file: relPath,
      line: lineAt(src, emptySitekey.index),
      message: `Turnstile \`sitekey\` is an empty string literal (OPE-150) — the widget can't mount.`,
    });
  }

  return violations;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry) && !full.includes("__tests__")) yield full;
  }
}

function main() {
  const all: Violation[] = [];
  const foundMounts: string[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      if (!isTurnstileFile(src)) continue;
      const rel = relative(ROOT, file);
      foundMounts.push(rel);
      all.push(...checkFile(rel, src));
    }
  }

  // Enumerate mounts; warn on any not in the known set (needs a human look).
  console.log(`Turnstile mounts scanned (${foundMounts.length}):`);
  for (const f of foundMounts) {
    const known = KNOWN_MOUNTS.has(f);
    console.log(
      `  ${known ? "✓" : "⚠"} ${f}${known ? "" : "  (NEW — add to KNOWN_MOUNTS after review)"}`
    );
  }
  const unknown = foundMounts.filter((f) => !KNOWN_MOUNTS.has(f));
  if (unknown.length > 0) {
    console.warn(
      `\nWARNING: ${unknown.length} Turnstile mount(s) not in KNOWN_MOUNTS. Not a failure, but confirm the new mount's size/sitekey and add it to scripts/check-turnstile-params.ts.`
    );
  }

  for (const v of all) {
    console.error(`ERROR ${v.file}:${v.line}  ${v.message}`);
  }

  console.log(`\n${all.length} violation(s).`);
  if (all.length > 0) {
    console.error(
      `\nA bad Turnstile size or missing sitekey blocks ALL signups (OPE-150, OPE-173 — twice in one week). Fix before merge.`
    );
    process.exit(1);
  }
  if (foundMounts.length === 0) {
    console.error(
      "\nERROR: no Turnstile mounts found at all. If Turnstile was intentionally removed, delete this check; otherwise a mount was renamed and this guard has gone blind."
    );
    process.exit(1);
  }
}

// Run as a script, but stay importable for unit tests (which exercise checkFile).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}

export const __test = { ALLOWED_SIZES, SITEKEY_ENV, KNOWN_MOUNTS };
