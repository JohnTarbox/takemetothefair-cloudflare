#!/usr/bin/env tsx
/**
 * Guard (OPE-908): every GitHub Actions workflow
 *   1. pins each third-party `uses:` to a full 40-character commit SHA, and
 *   2. declares a top-level `permissions:` block.
 *
 * Why a guard and not a one-time sweep: OPE-908's first pass pinned 32 of 34
 * uses and `.github/dependabot.yml` then stated "this repo pins every action".
 * The two misses (`actions/cache/restore` and `save`, both in the production
 * deploy job) survived two review passes because nothing could fail on them.
 * A tag like `@v6` is mutable — whoever controls the tag controls the code that
 * runs next to the Cloudflare API token.
 *
 * Local actions (`./…`) and `docker://` images are out of scope.
 *
 * Usage: npx tsx scripts/check-workflow-action-pins.ts
 * Exits 0 if clean, 1 with a list of offenders.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKFLOWS_DIR = resolve(ROOT, ".github/workflows");

const USES_RE = /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/;
const PINNED_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const TOP_LEVEL_PERMISSIONS_RE = /^permissions:/m;

function main() {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  const offenders: string[] = [];
  let pinned = 0;

  for (const file of files) {
    const text = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
    if (!TOP_LEVEL_PERMISSIONS_RE.test(text)) {
      offenders.push(`${file}: no top-level \`permissions:\` block`);
    }
    text.split("\n").forEach((line, i) => {
      const m = USES_RE.exec(line);
      if (!m) return;
      const ref = m[1];
      if (ref.startsWith("./") || ref.startsWith("docker://")) return;
      if (PINNED_RE.test(ref)) pinned++;
      else offenders.push(`${file}:${i + 1}: \`${ref}\` is not pinned to a 40-character SHA`);
    });
  }

  if (pinned === 0) {
    // A guard that matched nothing has checked nothing — fail rather than pass.
    offenders.push("no pinned `uses:` found at all — the pattern no longer matches the workflows");
  }

  if (offenders.length > 0) {
    console.error(`❌ ${offenders.length} workflow pin/permissions problem(s):`);
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }
  console.log(
    `✅ ${pinned} action uses SHA-pinned; ${files.length} workflows declare permissions.`
  );
}

main();
