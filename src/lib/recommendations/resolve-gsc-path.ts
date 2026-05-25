// Resolve a GSC-reported path against the slug-history tables so a rec card
// linking to a renamed URL points at the live canonical slug, not an old
// 301-redirected one. GSC reports historical URLs that lag behind renames
// by weeks; without this helper, admin clicks the card, hits a 301, and
// edits the right page anyway — but the surfaced link is confusing.
//
// Handles three entity kinds (events / blog / vendors). Static and listing
// pages pass through unchanged. Walks the chain max 5 hops with cycle
// detection, mirroring the middleware's slug-history walker.

import type { DrizzleD1Database } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { blogSlugHistory, eventSlugHistory, vendorSlugHistory } from "@/lib/db/schema";
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

export async function resolveGscPath(db: Db, path: string | null): Promise<string | null> {
  if (!path) return path;
  const parsed = parsePath(path);
  if (!parsed) return path;
  const table =
    parsed.kind === "events"
      ? eventSlugHistory
      : parsed.kind === "blog"
        ? blogSlugHistory
        : vendorSlugHistory;
  const resolved = await walkHistory(db, table, parsed.slug);
  if (resolved === parsed.slug) return path;
  return `/${parsed.kind}/${resolved}`;
}
