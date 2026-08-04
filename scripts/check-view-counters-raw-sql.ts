/**
 * CI guard (OPE-332) — per-view counters must not go through Drizzle.
 *
 * `updated_at` on the six public entity tables carries `$onUpdateFn`, so ANY
 * Drizzle `.update(<entity>)` stamps it. That column is now load-bearing twice
 * over: it is the HTTP validator behind 304 responses, and it is the sitemap
 * `<lastmod>` we report to search engines.
 *
 * A view counter routed through Drizzle therefore does two bad things at once:
 * the validator changes on every request so the 304 path can never fire, and
 * every page view tells Google the page changed. This exact bug shipped to
 * production on 2026-08-04 — the events counter had been converted, but the
 * vendor and blog counters had not, and prod showed their validators moving
 * between two requests two seconds apart.
 *
 * The rule is mechanical, so a script can hold it and a reviewer doesn't have
 * to remember. Increment view counts with `db.run(sql\`UPDATE ... SET
 * view_count = COALESCE(view_count, 0) + 1 ...\`)`.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ENTITY_TABLES = ["events", "vendors", "venues", "promoters", "performers", "blogPosts"];

const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx' 'mcp-server/**/*.ts'", {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.includes("__tests__") && !f.includes(".test."));

const violations: string[] = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const table of ENTITY_TABLES) {
    const marker = `.update(${table})`;
    let index = source.indexOf(marker);
    while (index !== -1) {
      // Look at this statement's SET clause only — up to its `.where(`.
      const tail = source.slice(index + marker.length, index + marker.length + 600);
      const end = tail.indexOf(".where(");
      const setClause = end > 0 ? tail.slice(0, end) : tail;
      // Only PER-VIEW increments (`+ 1`). Deliberately not every viewCount
      // write: merge_events sums the duplicate's count into the keeper, and
      // that update SHOULD stamp updated_at — the event really did change.
      // The distinction is "+ 1 on every request" vs "a one-time edit".
      if (/viewCount\s*:/.test(setClause) && /\+\s*1\b/.test(setClause)) {
        const line = source.slice(0, index).split("\n").length;
        violations.push(`${file}:${line} — .update(${table}) sets viewCount`);
      }
      index = source.indexOf(marker, index + 1);
    }
  }
}

if (violations.length > 0) {
  console.error("View counters must not go through Drizzle (OPE-332).\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nDrizzle updates stamp updated_at, which is the HTTP validator AND the" +
      "\nsitemap <lastmod>. Use raw SQL instead:" +
      "\n  await db.run(sql`UPDATE <table> SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ${id}`)"
  );
  process.exit(1);
}

console.log(`✓ no Drizzle-routed view counters (${files.length} files checked)`);
