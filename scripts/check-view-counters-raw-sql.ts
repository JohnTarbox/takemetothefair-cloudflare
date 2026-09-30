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

// ── OPE-796 — the other side of the same rule ────────────────────────────────
//
// Everything above checks HOW a counter is written. It is structurally blind to
// one that is never written at all, which is the defect OPE-796 found:
// `performers.view_count` shipped with OPE-112, was read by the weekly digest's
// `ORDER BY view_count DESC`, and had 0 across all 309 rows because nothing
// incremented it. The guard passed the whole time — correctly, and uselessly.
//
// So: any table that HAS a view_count column must also have an incrementer.
// Keyed on the ACT (a counter exists ⇒ something must feed it) rather than on
// the fix, because a guard keyed on the fix cannot see the fix being omitted.
const SCHEMA = readFileSync("packages/db-schema/src/index.ts", "utf8");

/** Tables declaring a `view_count` column, read from the schema itself. */
const tablesWithCounter = ENTITY_TABLES.filter((t) => {
  const start = SCHEMA.indexOf(`export const ${t} = sqliteTable`);
  if (start === -1) return false;
  const end = SCHEMA.indexOf("\n);", start);
  return SCHEMA.slice(start, end === -1 ? undefined : end).includes("viewCount");
});

/** snake_case table name as it appears in the raw UPDATE. */
const sqlName = (t: string) => t.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const allSource = files.map((f) => readFileSync(f, "utf8")).join("\n");
const uncounted = tablesWithCounter.filter(
  (t) => !allSource.includes(`UPDATE ${sqlName(t)} SET view_count`)
);

// Positive landmark: if the schema parse breaks, `tablesWithCounter` empties and
// `uncounted` is trivially [] — a clean bill of health for nothing.
if (tablesWithCounter.length < 3) {
  console.error(
    `View-counter guard FAILED (OPE-796):\n\n  Found only ${tablesWithCounter.length} tables with a view_count column.\n  The schema parse has stopped matching — fix it rather than trusting the\n  "no offenders" result.\n`
  );
  process.exit(1);
}

if (uncounted.length > 0) {
  console.error(
    "A view_count column with nothing to increment it (OPE-796).\n\n" +
      uncounted
        .map((t) => `  ${t}.view_count — no \`UPDATE ${sqlName(t)} SET view_count\` anywhere`)
        .join("\n") +
      "\n\nA counter that is read and never written reports 0 forever, and an" +
      "\nORDER BY over it is an arbitrary tie. Either wire the increment on the" +
      "\ndetail page (see vendors/[slug]/page.tsx) or drop the column."
  );
  process.exit(1);
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

console.log(
  `✓ view counters: ${files.length} files checked, none Drizzle-routed; ` +
    `${tablesWithCounter.length} tables declare view_count and all ${tablesWithCounter.length} have an incrementer ` +
    `(${tablesWithCounter.join(", ")})`
);
