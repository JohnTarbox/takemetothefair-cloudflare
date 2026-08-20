/**
 * OPE-278 item 3 — the `-N` slug suffix is dedup's own failure receipt.
 *
 * When two candidates collide, the SLUG layer notices (it appends `-1`, `-2`)
 * and the DEDUP layer does not. Three layers saw the Vineyard Artisans
 * collision on 2026-08-17 and none of them said anything. Nothing has ever
 * listened to that receipt.
 *
 * ── Why this is narrow, and why measuring first mattered ─────────────────
 *
 * The obvious implementation — "flag every event whose slug ends in `-N`" — is
 * wrong. Prod on 2026-08-20 holds **42** live events with a numeric-suffix
 * slug, and nearly all are already REJECTED, because a human caught them by
 * hand. Reporting 42 open defects where there are 2 is the same
 * "aggregate hides the state" failure this project keeps repeating.
 *
 * Two conditions narrow it to the ones nobody caught:
 *
 *   1. BOTH rows are still live (`APPROVED`/`TENTATIVE`, not merged away).
 *      A rejected twin is the system working, not a defect.
 *   2. Their start dates are within 7 days of each other. This guard is doing
 *      real work: `central-vermont-gun-show-1` (2027-02-06) against
 *      `central-vermont-gun-show` (2026-02-07) is two legitimate editions a
 *      year apart, and a slug-shape-only check would report it forever as a
 *      duplicate nobody can close.
 *
 * With both, prod returns exactly 2 — `boston-marathon-2026-1` vs
 * `boston-marathon-2026` (same venue, same date) and
 * `first-night-boston-2027-1` vs `first-night-boston-2027` (same date). Both
 * are publicly visible. That is the number worth alerting on.
 *
 * Reports, never acts: which row survives a real pair is a `merge_events`
 * decision with SEO consequences (slug history, redirects), not something a
 * health check should take unilaterally.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";

/**
 * 7 days in SECONDS.
 *
 * D1 stores these columns as seconds. A millisecond constant here would widen
 * the window to ~19,000 years and match every pair; getting the units backwards
 * elsewhere matches nothing and reports a clean zero — which reads exactly like
 * "fixed". Both failure modes are silent, hence the named constant and the
 * explicit test.
 */
export const COLLISION_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * `foo-bar-2` → `foo-bar`. Strips the trailing run of digits, then the `-`.
 *
 * Note this deliberately does NOT match an edition slug like `fryeburg-fair-2026`:
 * the GLOB below requires the character before the final digits to be a `-`
 * AND the whole trailing token to be what `rtrim` removes, so `-2026` reduces
 * to `fryeburg-fair` only if `fryeburg-fair` also exists as a live row on a
 * near-identical date — which is the duplicate case anyway.
 */
const BASE_SLUG_SQL = sql`substr(rtrim(d.slug,'0123456789'), 1, length(rtrim(d.slug,'0123456789')) - 1)`;

const WHERE_SQL = sql`d.slug GLOB '*-[0-9]'
  AND d.id <> b.id
  AND d.merged_into IS NULL AND b.merged_into IS NULL
  AND d.status IN ('APPROVED','TENTATIVE')
  AND b.status IN ('APPROVED','TENTATIVE')
  AND ((d.start_date IS NULL AND b.start_date IS NULL)
       OR abs(d.start_date - b.start_date) <= ${COLLISION_WINDOW_SECONDS})`;

export interface SlugCollisionPair {
  dup_id: string;
  dup_slug: string;
  dup_status: string;
  base_id: string;
  base_slug: string;
  base_status: string;
  same_venue: number;
  start_date: string | null;
}

/** Capped list plus true total, so a truncated list never reads as the whole. */
export async function findSlugCollisionPairs(
  db: Db,
  limit = 20
): Promise<{ violation_count: number; violations: SlugCollisionPair[] }> {
  const violations = (await db
    .select({
      dup_id: sql<string>`d.id`,
      dup_slug: sql<string>`d.slug`,
      dup_status: sql<string>`d.status`,
      base_id: sql<string>`b.id`,
      base_slug: sql<string>`b.slug`,
      base_status: sql<string>`b.status`,
      same_venue: sql<number>`(d.venue_id IS NOT NULL AND d.venue_id = b.venue_id)`,
      start_date: sql<string>`date(d.start_date, 'unixepoch')`,
    })
    .from(sql`events d`)
    .innerJoin(sql`events b`, sql`b.slug = ${BASE_SLUG_SQL}`)
    .where(WHERE_SQL)
    .limit(limit)) as SlugCollisionPair[];

  const [total] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sql`events d`)
    .innerJoin(sql`events b`, sql`b.slug = ${BASE_SLUG_SQL}`)
    .where(WHERE_SQL);

  return { violation_count: Number(total?.count ?? 0), violations };
}
