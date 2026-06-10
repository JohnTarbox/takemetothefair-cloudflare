#!/usr/bin/env tsx
/**
 * Guard: NO route handler or page in src/app/ may declare
 * `export const runtime = "edge"`.
 *
 * Inverted from the old `check-edge-runtime.ts` at the OpenNext migration
 * (2026-06-10). Under `@opennextjs/cloudflare` the app runs on the Node.js
 * runtime; an `edge` runtime declaration makes the OpenNext build fail with
 * "<route> cannot use the edge runtime". This guard catches a re-introduced
 * `runtime = "edge"` in CI instead of at build/deploy time.
 *
 * Usage: npx tsx scripts/check-no-edge-runtime.ts
 * Exits 0 if clean, 1 with a list of offenders.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP_DIR = resolve(ROOT, "src/app");

const EDGE_RUNTIME_RE = /^\s*export\s+const\s+runtime\s*=\s*["']edge["']/m;
const TARGET_FILENAMES = new Set(["route.ts", "route.tsx", "page.ts", "page.tsx"]);

function findTargetFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) findTargetFiles(full, out);
    else if (s.isFile() && TARGET_FILENAMES.has(entry)) out.push(full);
  }
  return out;
}

function main() {
  const files = findTargetFiles(APP_DIR);
  const offenders = files.filter((f) => EDGE_RUNTIME_RE.test(readFileSync(f, "utf8")));

  if (offenders.length === 0) {
    console.log(`OK ${files.length} route/page files scanned; none declare runtime = "edge".`);
    process.exit(0);
  }

  console.error(
    `\`runtime = "edge"\` found in ${offenders.length} file(s) — forbidden under OpenNext:\n`
  );
  for (const f of offenders) console.error(`  - ${f.slice(ROOT.length + 1)}`);
  console.error(
    "\nRemove the declaration. OpenNext runs on the Node.js runtime; an edge\n" +
      "runtime export breaks the `opennextjs-cloudflare build`."
  );
  process.exit(1);
}

main();
