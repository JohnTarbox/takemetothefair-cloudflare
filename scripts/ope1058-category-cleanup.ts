/**
 * OPE-1058 scope 2 — plan the one-time category rewrite, and emit the SQL.
 *
 * Ratified by John 2026-09-17. This script does NOT write: it takes the rows as
 * JSON on stdin (read from prod through the Cloudflare MCP `d1_database_query`,
 * the only read path this lane has — `[[feedback_prod_d1_blocked_via_wrangler]]`),
 * applies `cleanupEventCategories`, and prints
 *
 *   - a per-value plan with row counts, for the record, and
 *   - chunked SQL where each row's audit INSERT and its UPDATE sit in ONE
 *     statement list, so a partial run leaves a complete record of exactly what
 *     it changed (docs/bulk-mutation-discipline.md: single-writer, idempotent,
 *     read-back-verified, rollback-planned).
 *
 * Idempotent by construction: every target value maps to itself, so re-running
 * the emitted SQL changes nothing. Chunked at 20 rows because D1 caps a
 * statement at 100 bound parameters and each row binds 4.
 *
 *   cat rows.json | npx tsx scripts/ope1058-category-cleanup.ts > plan.sql
 */
import { readFileSync } from "node:fs";
import { cleanupEventCategories } from "../src/lib/events/category-cleanup";

interface Row {
  id: string;
  slug: string;
  categories: string | null;
  tags: string | null;
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

function main() {
  const input = readFileSync(0, "utf8");
  const rows = JSON.parse(input) as Row[];

  const changes: Array<{ row: Row; categories: string[]; tags: string[] }> = [];
  const perValue = new Map<string, number>();

  for (const row of rows) {
    const before = parseArray(row.categories);
    const result = cleanupEventCategories(before);
    const tagsBefore = parseArray(row.tags);
    const tagsAfter = [...tagsBefore];
    for (const t of result.addTags) if (!tagsAfter.includes(t)) tagsAfter.push(t);

    const categoriesChanged = JSON.stringify(result.categories) !== JSON.stringify(before);
    const tagsChanged = JSON.stringify(tagsAfter) !== JSON.stringify(tagsBefore);
    if (!categoriesChanged && !tagsChanged) continue;

    for (const value of before) {
      if (!result.categories.includes(value)) perValue.set(value, (perValue.get(value) ?? 0) + 1);
    }
    changes.push({ row, categories: result.categories, tags: tagsAfter });
  }

  console.log(`-- OPE-1058 category cleanup — ${changes.length} of ${rows.length} rows change.`);
  console.log("-- Per off-list value, rows touched:");
  for (const [value, n] of [...perValue.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`--   ${value}: ${n}`);
  }
  console.log("--");

  const now = Math.floor(Date.now() / 1000);
  const CHUNK = 20;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const chunk = changes.slice(i, i + CHUNK);
    console.log(`-- chunk ${i / CHUNK + 1} (${chunk.length} rows)`);
    for (const c of chunk) {
      const before = c.row.categories ?? "[]";
      const after = JSON.stringify(c.categories);
      const tagsBefore = c.row.tags ?? "[]";
      const tagsAfter = JSON.stringify(c.tags);
      // The audit row FIRST: if the pair is interrupted, the record of the
      // intended change exists and the UPDATE can be replayed or reversed.
      console.log(
        `INSERT INTO event_category_migration_log (id, event_id, categories_before, categories_after, tags_before, tags_after, migrated_at) ` +
          `VALUES (${sqlStr(`ope1058-${c.row.id}`)}, ${sqlStr(c.row.id)}, ${sqlStr(before)}, ${sqlStr(after)}, ${sqlStr(tagsBefore)}, ${sqlStr(tagsAfter)}, ${now}) ` +
          `ON CONFLICT(id) DO NOTHING;`
      );
      console.log(
        `UPDATE events SET categories = ${sqlStr(after)}, tags = ${sqlStr(tagsAfter)} WHERE id = ${sqlStr(c.row.id)};`
      );
    }
  }
}

main();
