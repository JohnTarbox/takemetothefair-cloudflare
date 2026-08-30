#!/usr/bin/env tsx
/**
 * OPE-640 — refuse a Web API that is above the declared browser support floor
 * in code that can reach the browser.
 *
 * Usage:
 *   npx tsx scripts/check-browser-api-floor.ts
 *
 * Exits 0 when no reachable above-floor call is found; exits 1 listing them.
 *
 * The ceiling
 * -----------
 * `crypto.randomUUID()` needs **Safari 15.4** (2022-03) and **Chrome 92**
 * (2021-07). It was called unguarded inside a `.map()` in `generateMultiDayICSContent`,
 * which runs DURING RENDER in a `"use client"` component on every `/events/*`
 * page. Visitors on Safari 14.1.2 and Chrome 90 got the React error boundary
 * INSTEAD OF THE PAGE — nine logged occurrences across eight events, accelerating,
 * every one `errorType: react-error-boundary`. The API is also `undefined` in
 * any non-secure context.
 *
 * FAM-BROWSER-SUPPORT-FLOOR. Same shape as the D1 caps this repo already guards
 * (FAM-D1-COLCAP, FAM-D1-PARAMCAP): an undocumented ceiling crossed silently,
 * where local development never crosses it because the developer's browser is
 * current. The ceiling here is a browser version rather than a D1 limit, and
 * the analogue of "local SQLite allows 50,000" is "Chrome 140 has every API".
 *
 * Why a repo script and not eslint-plugin-compat
 * ----------------------------------------------
 * Consistency with the four guards already wired into ci.yml, no new dependency,
 * and — the deciding reason — `eslint-plugin-compat` lints per-file against
 * `browserslist` with no notion of whether a file is CLIENT-reachable. This
 * codebase legitimately calls `crypto.randomUUID()` in ~30 server modules, where
 * the Workers runtime always provides it. A per-file rule would flag all of them,
 * get blanket-disabled, and then guard nothing — the explicit lesson recorded in
 * check-d1-inarray-params.ts.
 *
 * So reachability is the whole point: walk the import graph from every
 * `"use client"` entry and flag only what a browser can actually execute.
 * `src/lib/utils.ts` is the case that matters — a shared module, mostly used by
 * server code, pulled into the client bundle by ONE component.
 *
 * The floor
 * ---------
 * Declared in `package.json#browserslist` and documented in
 * `docs/browser-support-floor.md`. Raising the floor is a product decision:
 * change it there, then delete the entries here that it makes safe.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = ["node_modules", ".next", ".open-next", "dist", "__tests__", ".git"];
const ALLOWLIST_PATH = join(ROOT, "scripts", "check-browser-api-floor.allowlist");

/**
 * APIs above the declared floor (Safari 14 / Chrome 90).
 *
 * Each entry names the API, the versions that introduced it, and the fix. Keep
 * this list SHORT and true — an entry that is actually below the floor teaches
 * people to ignore the guard. `String.prototype.replaceAll` (Safari 13.1 /
 * Chrome 85) is deliberately absent for that reason: it is below the floor.
 */
const ABOVE_FLOOR: { pattern: RegExp; api: string; since: string; fix: string }[] = [
  {
    pattern: /\bcrypto\s*\.\s*randomUUID\s*\(/,
    api: "crypto.randomUUID()",
    since: "Safari 15.4 / Chrome 92",
    fix: "derive a deterministic id from domain data, or crypto.getRandomValues()",
  },
  {
    pattern: /(?<![.\w])structuredClone\s*\(/,
    api: "structuredClone()",
    since: "Safari 15.4 / Chrome 98",
    fix: "JSON round-trip, or an explicit clone helper",
  },
  {
    pattern: /\bObject\s*\.\s*hasOwn\s*\(/,
    api: "Object.hasOwn()",
    since: "Safari 15.4 / Chrome 93",
    fix: "Object.prototype.hasOwnProperty.call(obj, key)",
  },
  {
    pattern: /\.\s*findLast(Index)?\s*\(/,
    api: "Array.prototype.findLast()",
    since: "Safari 15.4 / Chrome 97",
    fix: "[...arr].reverse().find(...) or a manual loop",
  },
  {
    pattern: /\brequestIdleCallback\s*\(/,
    api: "requestIdleCallback()",
    since: "Safari 18.2",
    fix: "setTimeout fallback, or guard with `typeof requestIdleCallback === 'function'`",
  },
];

/** A guarded call is fine — the point is the UNguarded one. */
const GUARDED = /\?\.\s*\(|typeof\s+\w|["']randomUUID["']\s+in\b|&&\s*\w+\s*\.\s*randomUUID/;

interface Violation {
  file: string;
  line: number;
  api: string;
  since: string;
  fix: string;
  text: string;
  via: string;
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
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Does this file opt into the client bundle? */
export function isClientEntry(src: string): boolean {
  // The directive must be at the top, before any statement.
  const head = src.slice(0, 400);
  return /^\s*(\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(head);
}

/** Import specifiers in a module, in source order. */
export function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

/** Resolve a specifier to a repo file, or null for a bare/external package. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules or a workspace package — not our source
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/**
 * Every repo module a browser can execute: the transitive import closure of
 * the `"use client"` entries. Returns file -> the entry that pulled it in.
 */
function clientReachable(files: string[]): Map<string, string> {
  const reached = new Map<string, string>();
  const queue: [string, string][] = [];

  for (const f of files) {
    if (isClientEntry(readFileSync(f, "utf8"))) {
      const rel = relative(ROOT, f).split("\\").join("/");
      reached.set(f, rel);
      queue.push([f, rel]);
    }
  }
  while (queue.length) {
    const [file, entry] = queue.shift()!;
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of importSpecifiers(src)) {
      const target = resolveSpecifier(spec, file);
      if (!target || reached.has(target)) continue;
      reached.set(target, entry);
      queue.push([target, entry]);
    }
  }
  return reached;
}

/** Pure per-file scan, exported for unit tests. */
export function checkSource(rel: string, src: string, via: string): Violation[] {
  const out: Violation[] = [];
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
    for (const rule of ABOVE_FLOOR) {
      if (!rule.pattern.test(line)) continue;
      if (GUARDED.test(line)) continue;
      out.push({
        file: rel,
        line: i + 1,
        api: rule.api,
        since: rule.since,
        fix: rule.fix,
        text: line.slice(0, 120),
        via,
      });
    }
  });
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

function main(): void {
  const allow = loadAllowlist();
  const files = walk(join(ROOT, "src"));
  const reachable = clientReachable(files);
  const violations: Violation[] = [];
  let allowed = 0;

  for (const [abs, via] of reachable) {
    const rel = relative(ROOT, abs).split("\\").join("/");
    for (const v of checkSource(rel, readFileSync(abs, "utf8"), via)) {
      if (allow.has(v.file) || allow.has(`${v.file}:${v.line}`)) allowed++;
      else violations.push(v);
    }
  }

  for (const v of violations) {
    console.error(`✗ ${v.file}:${v.line}   ${v.api} — needs ${v.since}`);
    console.error(`    ${v.text}`);
    console.error(`    reaches the browser from (e.g.) ${v.via}`);
    console.error(`    → ${v.fix}`);
  }
  if (allowed > 0) console.log(`\nAllowlisted: ${allowed}`);

  console.log(
    `\nScanned ${reachable.size} client-reachable module(s) from ${
      files.filter((f) => isClientEntry(readFileSync(f, "utf8"))).length
    } "use client" entr(y|ies). ${violations.length} error(s).`
  );

  if (violations.length > 0) {
    console.error(
      `\nThe declared support floor is package.json#browserslist (see docs/browser-support-floor.md).`
    );
    console.error(
      `An above-floor API in client-reachable code serves the ERROR BOUNDARY instead of the page —`
    );
    console.error(
      `it does not degrade, it blanks. OPE-640: 9 such renders on /events/* before anyone noticed.`
    );
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
