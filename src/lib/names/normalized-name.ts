/**
 * The two halves of a name-equality comparison — one in JS, one in SQL — that
 * MUST agree.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * Extracted verbatim from `src/lib/venue-minting.ts` (OPE-541) so a second
 * caller does not become a second implementation. OPE-600 asks for the PR #257
 * name-equality fallback "rather than inventing a third approach", and a
 * normalizer that has already been corrected once is exactly the kind of thing
 * that must not be re-derived: the failure mode of a drifted normalizer is a
 * lookup that silently matches nothing, which is indistinguishable from "no
 * collision" — the very bug OPE-600 is about.
 *
 * ── The correction it already carries ───────────────────────────────────────
 * The first version normalized only the INPUT — `LOWER(TRIM(name))` on the
 * column against a quote-stripped string in JS — which meant the guard could
 * never match a name containing an apostrophe. That was the specimen's own
 * name ("Doody's Totoket Inn Restaurant"): the duplicate-suppressing guard was
 * inert for precisely the row the ticket was about, and silently, in the
 * direction that creates duplicates.
 *
 * Curly quotes are folded too. Extractors take prose from web pages, where
 * U+2019 is what a typographic apostrophe actually is; treating it as a
 * different character from `'` would reopen the same hole one codepoint over.
 */
import { sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

export const STRIPPED_QUOTES = ['"', "'", "`", "’", "‘"];

/** JS half. */
export function normalizeName(s: string): string {
  let out = s.toLowerCase();
  for (const q of STRIPPED_QUOTES) out = out.split(q).join("");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * SQL half — the same steps in the same order, over a column.
 *
 * Whitespace: SQLite has no regex, so runs are collapsed by three passes of
 * `REPLACE('  ', ' ')`, which flattens up to 8 consecutive spaces. Tabs and
 * newlines are mapped to spaces first. A name with more than 8 consecutive
 * spaces falls back to not matching, which is always the safe direction.
 */
export function normalizedNameSql(col: SQLiteColumn) {
  let expr = sql`LOWER(${col})`;
  for (const q of STRIPPED_QUOTES) {
    expr = sql`REPLACE(${expr}, ${q}, '')`;
  }
  expr = sql`REPLACE(REPLACE(${expr}, char(9), ' '), char(10), ' ')`;
  for (let i = 0; i < 3; i++) expr = sql`REPLACE(${expr}, '  ', ' ')`;
  return sql`TRIM(${expr})`;
}
