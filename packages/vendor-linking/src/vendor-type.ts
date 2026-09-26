/**
 * OPE-1113 — one spelling per vendor category (John's ruling, 2026-09-25).
 *
 * `vendors.vendor_type` is free text, and it had grown 49 groups of values that
 * differ ONLY by case, surrounding whitespace, or a plain plural ("Craft" 62 vs
 * "Crafts" 331; "Artist" 69 vs "artist" 59). Each group was merged onto its
 * most-used spelling in a one-off pass; this module stops the groups growing
 * back by resolving a value to that existing spelling at WRITE time.
 *
 * ── The rule, and only the rule ──────────────────────────────────────────
 *
 *   same category  ⇔  same fold key, where the fold key is lower-case, trimmed,
 *                      inner whitespace collapsed, and a trailing plural folded
 *                      ("…ies"→"…y", "…s"→"" unless "…ss")
 *
 * plus the two pairs John named (Non-Profit → Nonprofit, Woodwork →
 * Woodworking). Different WORDS are different categories: "Fine Craft" is not
 * "Craft", "Fiber" is not "Fiber Arts", "Marine" is not "Marine Services". That
 * line is the ruling — widening it is a product decision (OPE-1164), not a
 * cleanup.
 */
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@takemetothefair/db-schema";
import { vendors } from "@takemetothefair/db-schema";

/** Named merges from the ruling, keyed by fold key → canonical spelling. */
export const VENDOR_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "non-profit": "Nonprofit",
  woodwork: "Woodworking",
};

function squash(v: string): string {
  return v.trim().replace(/\s+/g, " ");
}

/** Case/whitespace/plural-insensitive identity of a category. Pure. */
export function vendorTypeFoldKey(value: string): string {
  const v = squash(value).toLowerCase();
  if (v.endsWith("ies") && v.length > 3) return `${v.slice(0, -3)}y`;
  if (v.endsWith("s") && !v.endsWith("ss") && v.length > 1) return v.slice(0, -1);
  return v;
}

/** Fold key after applying the named aliases. Pure. */
export function vendorTypeKey(value: string): string {
  const k = vendorTypeFoldKey(value);
  const alias = VENDOR_TYPE_ALIASES[k];
  return alias ? vendorTypeFoldKey(alias) : k;
}

/** True when two stored/proposed values name the same category. Pure. */
export function sameVendorType(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  if (x === "" || y === "") return x === y;
  return vendorTypeKey(x) === vendorTypeKey(y);
}

/**
 * Pick the spelling to store from the existing values of the same category.
 * Most vendors wins; ties go to the capitalised form, then the longer (plural)
 * one, then alphabetical — deterministic, so two writers never disagree.
 * With no existing value, the alias target or the squashed input is returned.
 * Pure — exported for tests.
 */
export function pickVendorTypeSpelling(
  input: string,
  existing: ReadonlyArray<{ value: string; count: number }>
): string {
  const squashed = squash(input);
  const key = vendorTypeKey(squashed);
  const same = existing.filter((e) => e.value.trim() !== "" && vendorTypeKey(e.value) === key);
  if (same.length === 0) return VENDOR_TYPE_ALIASES[vendorTypeFoldKey(squashed)] ?? squashed;
  const byValue = new Map<string, number>();
  for (const e of same) {
    const v = squash(e.value);
    byValue.set(v, (byValue.get(v) ?? 0) + e.count);
  }
  const ranked = [...byValue.entries()].sort(
    ([a, n], [b, m]) =>
      m - n ||
      Number(/^[A-Z]/.test(b)) - Number(/^[A-Z]/.test(a)) ||
      b.length - a.length ||
      a.localeCompare(b)
  );
  return ranked[0][0];
}

/** Lower-cased spellings whose fold key could equal `key`'s. */
function candidateLowerForms(value: string): string[] {
  const base = squash(value).toLowerCase();
  const out = new Set<string>([base]);
  const k = vendorTypeFoldKey(base);
  out.add(k);
  out.add(`${k}s`);
  if (k.endsWith("y")) out.add(`${k.slice(0, -1)}ies`);
  const alias = VENDOR_TYPE_ALIASES[k];
  if (alias) for (const f of candidateLowerForms(alias)) out.add(f);
  // Every alias SOURCE that points at this category (so "Nonprofit" also
  // finds rows still spelled "Non-Profit").
  for (const [src, target] of Object.entries(VENDOR_TYPE_ALIASES)) {
    if (vendorTypeFoldKey(target) === k) {
      out.add(src);
      out.add(`${src}s`);
    }
  }
  return [...out];
}

type VendorTypeDb = DrizzleD1Database<typeof schema>;

/**
 * Resolve a vendor_type about to be written to the existing spelling of the
 * same category. Blank → null. Unknown category → stored as given (squashed).
 * Reads at most a handful of rows via the lower(trim()) candidates.
 */
export async function resolveVendorTypeForWrite(
  db: VendorTypeDb,
  input: string | null | undefined
): Promise<string | null> {
  if (input == null) return null;
  const squashed = squash(input);
  if (squashed === "") return null;
  const forms = candidateLowerForms(squashed);
  const rows = await db
    .select({ value: sql<string>`trim(${vendors.vendorType})`, count: sql<number>`count(*)` })
    .from(vendors)
    .where(
      sql`lower(trim(${vendors.vendorType})) IN (${sql.join(
        forms.map((f) => sql`${f}`),
        sql`, `
      )})`
    )
    .groupBy(sql`trim(${vendors.vendorType})`);
  return pickVendorTypeSpelling(
    squashed,
    rows.map((r) => ({ value: r.value, count: Number(r.count) }))
  );
}
