/**
 * OPE-1185 — no multi-row INSERT built from a growing list may bypass
 * `runChunkedInsert`.
 *
 * `import_bing_backlinks` 500'd on every CSV past 20 rows because one
 * `.values(rows.map(...))` statement bound 5 × N parameters against D1's cap of
 * 100. The audit that fixed it found FIVE more of the same shape (vendor
 * self-reported events, three enrichment-candidate writers, syndication
 * subscriptions), each a 500 waiting for its list to grow — and local SQLite
 * (32k params) cannot show any of them. A fix-list regrows; this is the guard.
 *
 * Rule: `.values(<name>.map(` is refused unless `<name>` is `chunk` — the
 * parameter `runChunkedInsert`'s builder receives. A genuinely bounded list can
 * opt out with a `// d1-rows-bounded: <reason>` comment on the line above.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const ROOTS = ["src", "mcp-server/src", "packages"];
const MULTIROW = /\.values\(\s*([A-Za-z_$][\w$.]*)\.map\(/g;

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

export function findUnchunkedInserts(files: Array<{ path: string; text: string }>) {
  const hits: string[] = [];
  let scanned = 0;
  for (const { path, text } of files) {
    for (const m of text.matchAll(MULTIROW)) {
      scanned++;
      if (m[1] === "chunk") continue;
      const before = text.slice(0, m.index).split("\n").slice(-4).join("\n");
      if (/d1-rows-bounded:/.test(before)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      hits.push(`${path}:${line}  .values(${m[1]}.map(...))`);
    }
  }
  return { hits, scanned };
}

describe("OPE-1185 — multi-row inserts go through runChunkedInsert", () => {
  it("the real tree has none that bypass it, and the scan saw the fixed sites", () => {
    const paths: string[] = [];
    for (const r of ROOTS) walk(join(ROOT, r), paths);
    const files = paths.map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));
    const { hits, scanned } = findUnchunkedInserts(files);
    expect(hits, "wrap each in runChunkedInsert (@takemetothefair/utils)").toEqual([]);
    // Landmark: the six converted sites are matched (as `chunk.map`), so a
    // pattern that silently stopped matching cannot read as a clean tree.
    expect(scanned).toBeGreaterThanOrEqual(6);
  });

  it("DRIVEN TO FAILURE: the pre-fix bing importer shape is caught", () => {
    const { hits } = findUnchunkedInserts([
      {
        path: "x.ts",
        text: "await db\n  .insert(bingBacklinks)\n  .values(\n    rows.map((r) => ({ a: r }))\n  );",
      },
    ]);
    expect(hits).toHaveLength(1);
  });

  it("an explicit, reasoned opt-out is honoured", () => {
    const { hits } = findUnchunkedInserts([
      {
        path: "x.ts",
        text: "// d1-rows-bounded: at most 3 rows (fixed enum)\nawait db.insert(t).values(kinds.map((k) => ({ k })));",
      },
    ]);
    expect(hits).toEqual([]);
  });
});
