/**
 * OPE-1128 — fail the build when an EMITTED client chunk contains a lookbehind
 * regex LITERAL (`(?<=` / `(?<!`).
 *
 * Safari < 16.4 cannot parse lookbehind. A regex literal is checked when the
 * whole script is parsed, so one literal anywhere in a chunk throws a
 * SyntaxError for that chunk, and every route that loads it shows the error
 * boundary. That happened twice: first from our own `blog-faq-coherence.ts`,
 * which `check-browser-api-floor.ts` now covers, then from a DEPENDENCY
 * (remark-gfm's email autolink in chunk 7466), which no source-level scan can
 * see. Only the emitted bundle is the truth about what ships.
 *
 * Literals only, on purpose. `new RegExp("(?<=…)")` inside a try is how
 * libraries (core-js among them) feature-test, and it is harmless: a string
 * parses everywhere and fails only at runtime, where the try catches it. So
 * chunks are parsed with TypeScript's parser and only RegularExpressionLiteral
 * nodes are inspected; strings and comments are never matched.
 *
 * A guard that examines nothing must not pass: a missing or empty chunk
 * directory fails, and the success line names how many chunks and regex
 * literals were examined.
 *
 * Usage (after `next build` / `opennextjs-cloudflare build`):
 *   npx tsx scripts/check-emitted-regex-floor.ts [chunkDir]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Regex-literal source text that Safari < 16.4 cannot parse. */
const LOOKBEHIND = /\(\?<[=!]/;

export interface RegexFloorOffender {
  file: string;
  literal: string;
}

export function findLookbehindLiterals(
  code: string,
  file = "chunk.js"
): { offenders: RegexFloorOffender[]; literals: number } {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const offenders: RegexFloorOffender[] = [];
  let literals = 0;
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      literals++;
      const text = (node as ts.RegularExpressionLiteral).text;
      if (LOOKBEHIND.test(text)) offenders.push({ file, literal: text.slice(0, 120) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { offenders, literals };
}

function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJs(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

function main() {
  const dir = resolve(process.argv[2] ?? ".next/static/chunks");
  if (!existsSync(dir)) {
    console.error(
      `✗ ${dir} does not exist — run the build first. A guard that scans nothing must not pass.`
    );
    process.exit(1);
  }
  const files = listJs(dir);
  if (files.length === 0) {
    console.error(`✗ ${dir} contains no .js chunks — nothing was examined.`);
    process.exit(1);
  }
  const offenders: RegexFloorOffender[] = [];
  let literals = 0;
  for (const f of files) {
    const r = findLookbehindLiterals(readFileSync(f, "utf8"), relative(process.cwd(), f));
    offenders.push(...r.offenders);
    literals += r.literals;
  }
  console.log(`emitted chunks examined: ${files.length}, regex literals examined: ${literals}`);
  if (offenders.length > 0) {
    for (const o of offenders) console.error(`✗ ${o.file}: lookbehind regex literal ${o.literal}`);
    console.error(
      "Safari < 16.4 cannot parse these, so the whole chunk fails to load. Rewrite without " +
        "lookbehind, or keep the module off client routes (render it on the server). See OPE-1128."
    );
    process.exit(1);
  }
  console.log("✓ no lookbehind regex literals in emitted client chunks");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
