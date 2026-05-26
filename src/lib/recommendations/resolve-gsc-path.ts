// Resolve a GSC-reported path against the slug-history tables so a rec card
// linking to a renamed URL points at the live canonical slug, not an old
// 301-redirected one. GSC reports historical URLs that lag behind renames
// by weeks; without this helper, admin clicks the card, hits a 301, and
// edits the right page anyway — but the surfaced link is confusing.
//
// Handles three entity kinds (events / blog / vendors). Static and listing
// pages pass through unchanged. Walks the chain max 5 hops with cycle
// detection, mirroring the middleware's slug-history walker.
//
// Liveness check (analyst 2026-05-26): after resolving through history, we
// verify the final slug actually exists as a current canonical row. If it
// doesn't (event deleted / never existed / page renamed beyond what slug-
// history captured), the path is "stale" — GSC is still reporting clicks
// on a URL the site no longer serves. Callers can drop stale items so the
// actionable queue isn't polluted with already-fixed work.

import type { DrizzleD1Database } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  blogPosts,
  blogSlugHistory,
  events,
  eventSlugHistory,
  vendors,
  vendorSlugHistory,
} from "@/lib/db/schema";
import { unsafeSlug } from "@/lib/utils";

const MAX_HOPS = 5;

type Db = DrizzleD1Database<typeof schema>;

interface ParsedPath {
  kind: "events" | "blog" | "vendors";
  slug: string;
}

function parsePath(path: string): ParsedPath | null {
  const m = path.match(/^\/(events|blog|vendors)\/([^/?#]+)$/);
  if (!m) return null;
  return { kind: m[1] as ParsedPath["kind"], slug: m[2] };
}

async function walkHistory(
  db: Db,
  table: typeof eventSlugHistory | typeof blogSlugHistory | typeof vendorSlugHistory,
  startSlug: string
): Promise<string> {
  let cursor = startSlug;
  const seen = new Set<string>([cursor]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const [row] = await db
      .select({ newSlug: table.newSlug })
      .from(table)
      .where(eq(table.oldSlug, unsafeSlug(cursor)))
      .orderBy(desc(table.changedAt))
      .limit(1);
    if (!row || seen.has(row.newSlug)) break;
    cursor = row.newSlug;
    seen.add(cursor);
  }
  return cursor;
}

async function canonicalSlugExists(
  db: Db,
  kind: ParsedPath["kind"],
  slug: string
): Promise<boolean> {
  const branded = unsafeSlug(slug);
  if (kind === "events") {
    const [row] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, branded))
      .limit(1);
    return Boolean(row);
  }
  if (kind === "blog") {
    const [row] = await db
      .select({ id: blogPosts.id })
      .from(blogPosts)
      .where(eq(blogPosts.slug, branded))
      .limit(1);
    return Boolean(row);
  }
  const [row] = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.slug, branded))
    .limit(1);
  return Boolean(row);
}

export type GscPathStatus = "live" | "renamed" | "stale" | "non-entity" | "empty";

export interface GscPathResolution {
  /** Resolved path. For stale entries this is still the most-resolved form
   *  (so admin sees what GSC is reporting); callers should drop on status. */
  path: string | null;
  status: GscPathStatus;
}

/** Resolve a GSC-reported path. Returns a structured result so callers can
 *  distinguish live / renamed / stale and decide whether to surface or drop.
 *  Stale = the entity at the resolved slug no longer exists, meaning GSC is
 *  reporting clicks on a URL the site no longer canonical-serves. */
export async function resolveGscPath(db: Db, path: string | null): Promise<GscPathResolution> {
  if (!path) return { path, status: "empty" };
  const parsed = parsePath(path);
  if (!parsed) return { path, status: "non-entity" };

  const table =
    parsed.kind === "events"
      ? eventSlugHistory
      : parsed.kind === "blog"
        ? blogSlugHistory
        : vendorSlugHistory;
  const resolved = await walkHistory(db, table, parsed.slug);
  const resolvedPath = `/${parsed.kind}/${resolved}`;

  const exists = await canonicalSlugExists(db, parsed.kind, resolved);
  if (!exists) return { path: resolvedPath, status: "stale" };

  return {
    path: resolvedPath,
    status: resolved === parsed.slug ? "live" : "renamed",
  };
}
