/**
 * OPE-408 (bounce 2026-09-23) — the nightly geocode sweep never got past its
 * first page.
 *
 * The 08:30 cron called `/api/admin/venues/geocode-venues` ONCE with
 * `{ missing_only: true }` and no `after_id`. The route's OPE-214 keyset cursor
 * worked; nothing fed it back. So every night re-read the same first 25
 * `latitude IS NULL` venues by id — which, once the easy ones were pinned, were
 * exactly the 25 the gate refuses (low-confidence, non-point, duplicate-place).
 * Prod: `next_cursor` was the same `b3c4004c…` on 14 consecutive nights, 3
 * writes in 26 runs, while 60 fully-addressed venues created on 09-23 sat
 * unpinned behind the stuck page.
 *
 * Two bounds, because each geocode is a billed Google call:
 *
 *   - `maxPages` per night (4 × 25 = 100 venues ≈ 3,000 calls/month), so the
 *     refused tail cannot turn one night into an unbounded re-billing loop;
 *   - the cursor PERSISTS across nights, so the cap cannot recreate the same
 *     stall at page 4. The state is the sweep's own audit trail: every page the
 *     route serves writes a `venue.geocode.sweep` row carrying `next_cursor`,
 *     so the next night resumes from the newest one — no new storage, and the
 *     rows an operator reads ARE the cursor.
 *
 * A null `next_cursor` means the backlog was walked to the end; the next night
 * starts from the beginning, which is how rows refused earlier get retried.
 */

export const GEOCODE_SWEEP_MAX_PAGES = 4;

export interface SweepPage {
  next_cursor?: unknown;
}

export interface SweepOutcome {
  pages: number;
  startedAfter: string | null;
  endedAt: string | null;
  stoppedBy: "exhausted" | "cap" | "error";
}

/** Walk the keyset cursor from `start`, at most `maxPages` calls. */
export async function sweepGeocodePages(
  callPage: (afterId: string | null) => Promise<SweepPage | null>,
  start: string | null,
  maxPages: number = GEOCODE_SWEEP_MAX_PAGES
): Promise<SweepOutcome> {
  let cursor = start;
  let pages = 0;
  while (pages < maxPages) {
    const page = await callPage(cursor);
    pages++;
    if (!page) return { pages, startedAfter: start, endedAt: cursor, stoppedBy: "error" };
    const next = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : null;
    if (!next) return { pages, startedAfter: start, endedAt: null, stoppedBy: "exhausted" };
    cursor = next;
  }
  return { pages, startedAfter: start, endedAt: cursor, stoppedBy: "cap" };
}

/** Where last night stopped: the newest sweep row's `next_cursor`, or null. */
export async function lastGeocodeSweepCursor(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT json_extract(payload_json, '$.next_cursor') AS cursor
         FROM admin_actions
        WHERE action = 'venue.geocode.sweep'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`
    )
    .first<{ cursor: string | null }>();
  return typeof row?.cursor === "string" && row.cursor ? row.cursor : null;
}
