/**
 * OPE-40 — crawlable browse-directory helpers.
 *
 * The vendor/venue hub pages only expose entities through deep `?page=N`
 * pagination (2,994 vendors / 50 = ~60 pages), so Google never crawls deep
 * enough to reach most detail pages — the root cause of the ~3,850 orphaned
 * "Discovered – currently not indexed" pages. These helpers back shallow A–Z
 * and by-state index pages so every entity is reachable within ~3 clicks of the
 * homepage via plain `<a href>` links.
 */
import { getIndexableVendorRows } from "@/lib/sitemap/indexable-vendors";
// OPE-831 — the state vocabulary + predicate now live in a dependency-free
// module so the vendor profile form (a client component) can share them
// rather than re-implementing the rule. Re-exported here so every existing
// importer of this file keeps working unchanged.
import { US_STATE_NAMES, isBrowseStateCode } from "./state-codes";
export { US_STATE_NAMES, isBrowseStateCode };
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { venues } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export interface BrowseEntry {
  slug: string;
  name: string;
  state: string | null;
}

/** A–Z buckets plus a "#" catch-all for names that don't start with a letter. */
export const BROWSE_LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "#"] as const;

/** The bucket key for a name: its uppercase first letter, or "#". */
export function browseInitial(name: string): string {
  const c = name.trim().charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

/** Group entries by first-letter bucket, each list name-sorted. */
export function groupByInitial(entries: BrowseEntry[]): Map<string, BrowseEntry[]> {
  const map = new Map<string, BrowseEntry[]>();
  for (const e of entries) {
    const k = browseInitial(e.name);
    (map.get(k) ?? map.set(k, []).get(k)!).push(e);
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}

/**
 * Group entries by 2-letter state code (uppercased); blanks bucket to "".
 *
 * OPE-643 — codes outside the facet vocabulary are skipped. Filtering HERE
 * rather than in the page covers all four surfaces at once: the vendor and
 * venue browse indexes and both `[state]` detail routes share this grouper.
 * `venues.state` happens to be clean today (0 non-US values on 2026-08-30)
 * precisely because `create_venue` is the one writer that enforces max-2 — but
 * the code path is identical, and patching only the vendor side would be the
 * one-of-two-parallel-paths defect again.
 */
export function groupByState(entries: BrowseEntry[]): Map<string, BrowseEntry[]> {
  const map = new Map<string, BrowseEntry[]>();
  for (const e of entries) {
    const k = (e.state ?? "").trim().toUpperCase();
    if (!k) continue;
    if (!isBrowseStateCode(k)) continue;
    (map.get(k) ?? map.set(k, []).get(k)!).push(e);
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}

export function stateLabel(code: string): string {
  return US_STATE_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

/** Slug form of a state code for URLs, e.g. "ME" -> "me". */
export function stateSlug(code: string): string {
  return code.trim().toLowerCase();
}

/** URL token for a first-letter bucket: "A".."Z" -> "a".."z", "#" -> "other". */
export function letterToken(bucket: string): string {
  return bucket === "#" ? "other" : bucket.toLowerCase();
}

/**
 * Every index-eligible vendor as a browse entry (same public gate as the
 * vendor sitemap, so we never surface a noindex page). Name = display override
 * when set, else business name. Sorted by name.
 */
export async function getVendorBrowseEntries(db: Db): Promise<BrowseEntry[]> {
  const rows = await getIndexableVendorRows(db);
  return rows
    .map((r) => ({
      slug: r.slug,
      name: (r.displayName ?? r.businessName ?? "").trim() || r.businessName,
      state: r.fields.state ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every active venue as a browse entry. Mirrors the venues sitemap's gate
 * (status = 'ACTIVE'), so browse and sitemap stay in lock-step. Sorted by name.
 */
export async function getVenueBrowseEntries(db: Db): Promise<BrowseEntry[]> {
  const rows = await db
    .select({ slug: venues.slug, name: venues.name, state: venues.state })
    .from(venues)
    .where(eq(venues.status, "ACTIVE"));
  return rows
    .map((r) => ({ slug: r.slug, name: r.name, state: r.state ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
