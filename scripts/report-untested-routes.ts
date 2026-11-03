#!/usr/bin/env tsx
/**
 * REPORT (warn-only, OPE-1377): list `route.ts` handlers under src/app that no
 * test file references, and print the count so it is visible on every CI run.
 *
 * This is a heuristic, not a coverage measurement — a test can reach a route
 * indirectly (through a shared helper) and not be counted. A route counts as
 * tested when ANY of these holds:
 *
 *   1. a test file sits in the route's own directory or its `__tests__/`
 *      (the colocated `import { POST } from "../route"` pattern);
 *   2. a test file imports it by path (`app/api/foo/[id]/route`);
 *   3. a test file names its URL, with each dynamic `[segment]` matched by any
 *      concrete value (`/api/foo/abc123` counts for `/api/foo/[id]`).
 *
 * Always exits 0. Pass `--list` to print every untested route.
 *
 * Usage: npx tsx scripts/report-untested-routes.ts [--list]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP_DIR = resolve(ROOT, "src/app");
const TEST_ROOTS = ["src", "mcp-server/src", "mcp-server/__tests__", "e2e", "packages"].map((p) =>
  resolve(ROOT, p)
);
const SKIP_DIRS = new Set(["node_modules", ".next", ".open-next", "dist", ".wrangler"]);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|mjs)$/;
const ROUTE_FILES = new Set(["route.ts", "route.tsx"]);

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, keep, out);
    else if (s.isFile() && keep(entry)) out.push(full);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `/api/foo/[id]` → regex matching `/api/foo/<anything>` at a path boundary. */
function urlPattern(routePath: string): RegExp {
  const parts = routePath
    .split("/")
    .filter((seg) => !/^\(.*\)$/.test(seg)) // route groups don't appear in URLs
    .map((seg) => {
      if (/^\[\[?\.\.\./.test(seg)) return "[^\\s\"'`]+"; // catch-all
      if (/^\[.+\]$/.test(seg)) return "[^/\\s\"'`?#]+";
      return escapeRe(seg);
    });
  // The URL must END here (quote / whitespace / query / hash / punctuation),
  // so `/api/foo/[id]` is not credited by a test of `/api/foo/[id]/bar` — a
  // negative lookahead would let the dynamic segment backtrack (`[id` + `]`).
  return new RegExp(`${parts.join("/")}(?=[\\s"'\`?#),;]|$)`, "m");
}

function main() {
  const listAll = process.argv.includes("--list");
  const routes = walk(APP_DIR, (n) => ROUTE_FILES.has(n)).sort();
  const tests = TEST_ROOTS.flatMap((r) => walk(r, (n) => TEST_FILE_RE.test(n)));
  const testBodies = tests.map((f) => ({ file: f, body: readFileSync(f, "utf8") }));

  const untested: string[] = [];
  for (const route of routes) {
    const routeDir = dirname(route);
    // "/api/foo/[id]" — the path segment below src/app, POSIX separators.
    const routePath = "/" + relative(APP_DIR, routeDir).split(sep).join("/");
    const importNeedle = `app${routePath}/route`;
    const urlRe = urlPattern(routePath);

    const covered = testBodies.some(({ file, body }) => {
      const d = dirname(file);
      if (d === routeDir || d === join(routeDir, "__tests__")) return true;
      if (body.includes(importNeedle)) return true;
      return urlRe.test(body);
    });
    if (!covered) untested.push(relative(ROOT, route).split(sep).join("/"));
  }

  const pct = routes.length ? Math.round((untested.length / routes.length) * 100) : 0;
  console.log(
    `Untested route report (warn-only, OPE-1377): ${untested.length} of ${routes.length} route.ts files (${pct}%) have no test referencing them.`
  );
  const shown = listAll ? untested : untested.slice(0, 40);
  for (const r of shown) console.log(`  - ${r}`);
  if (shown.length < untested.length) {
    console.log(`  … and ${untested.length - shown.length} more (run with --list for all)`);
  }
  if (untested.length > 0) {
    // GitHub Actions annotation so the number shows on the run summary.
    console.log(
      `::warning title=Untested routes::${untested.length} of ${routes.length} route.ts files have no test referencing them`
    );
  }
  process.exit(0);
}

main();
