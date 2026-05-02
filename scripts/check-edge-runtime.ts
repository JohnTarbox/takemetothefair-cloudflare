#!/usr/bin/env tsx
/**
 * Verify that every Next.js route handler and page in src/app/ that does
 * any I/O exports `runtime = "edge"`. Without it, the route silently lands
 * on the Node runtime, which doesn't run on Cloudflare Pages.
 *
 * Usage:
 *   npx tsx scripts/check-edge-runtime.ts
 *
 * Exits 0 if every applicable file declares the runtime, 1 with a list
 * of offenders if not.
 *
 * Heuristic: scan every src/app/** /{route,page}.{ts,tsx} file. If the
 * file contains an async export (likely an I/O handler), it must include
 * `export const runtime = "edge"` at the top level.
 *
 * Pages without async exports (purely static) can omit the directive —
 * Next.js defaults them to the static runtime, which is also fine on
 * Cloudflare Pages.
 *
 * Replaces the convention-only enforcement noted in
 * `feedback_edge_runtime_export.md`. Wired into CI via the Lint job.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP_DIR = resolve(ROOT, "src/app");

const ASYNC_EXPORT_RE =
  /^\s*export\s+(?:async\s+function|default\s+async\s+function|const\s+\w+\s*=\s*async)/m;
const RUNTIME_DECL_RE = /^\s*export\s+const\s+runtime\s*=\s*["']edge["']/m;

const TARGET_FILENAMES = new Set(["route.ts", "route.tsx", "page.ts", "page.tsx"]);

function findTargetFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      findTargetFiles(full, out);
    } else if (s.isFile() && TARGET_FILENAMES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const files = findTargetFiles(APP_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const hasAsyncExport = ASYNC_EXPORT_RE.test(source);
    const hasRuntimeDecl = RUNTIME_DECL_RE.test(source);
    if (hasAsyncExport && !hasRuntimeDecl) {
      offenders.push(file.slice(ROOT.length + 1));
    }
  }

  if (offenders.length === 0) {
    console.log(
      `OK ${files.length} route/page files scanned; all I/O handlers declare runtime = "edge".`
    );
    process.exit(0);
  }

  console.error(`Edge runtime declaration missing in ${offenders.length} file(s):\n`);
  for (const f of offenders) {
    console.error(`  - ${f}`);
  }
  console.error(
    '\nAdd `export const runtime = "edge";` near the top of each file. Without it,\n' +
      "the handler runs on the Node runtime, which doesn't deploy to Cloudflare Pages."
  );
  process.exit(1);
}

main();
