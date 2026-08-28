/**
 * OPE-611 — `lifecycle_status='TENTATIVE'` had no way out.
 *
 * ── The specimen ────────────────────────────────────────────────────────────
 * The Aug 28–30 weekend digest had ZERO New Hampshire events on the biggest
 * fair weekend of the year. Not a discovery failure: the Capital Mineral Club
 * Gem, Mineral & Jewelry Show (Concord NH, 1,486 views) was in the database and
 * correct in every field — dates stated twice on the organizer's own site, an
 * ACTIVE `official_website` citation at 0.95 confidence, `dates_confirmed = 1`,
 * `gate_flags` NULL. One field suppressed it from the digest:
 * `lifecycle_status = 'TENTATIVE'`. Nothing had ever revisited it, and it was
 * found by hand ONE DAY before it opened.
 *
 * ── What the grep found, which narrows the ticket's claim ───────────────────
 * The ticket inferred "nothing writes TENTATIVE→SCHEDULED except a hand edit"
 * from the data pattern, and marked it explicitly as an inference. Grepping
 * every `lifecycleStatus` write confirms it, with one refinement worth keeping:
 * the lifecycle machinery is NOT unused. `event-occurred-sweep.ts:121` promotes
 * to OCCURRED automatically on a cron. So the transition rail works and has a
 * working precedent — what was missing is a SCHEDULED trigger and any reader.
 *
 * Writers, all of them:
 *   TENTATIVE  ← create-occurrence-core, event-rollover, vendor.ts, submit route
 *   OCCURRED   ← event-occurred-sweep (automatic, cron)
 *   any        ← admin lifecycle route + `update_event_lifecycle` MCP tool (hand)
 *
 * ── Why this file exposes a queue and does not promote anything ─────────────
 * Promotion changes what appears in customer-facing email and on public pages;
 * a false promotion advertises an event that may not happen. The ticket
 * STOP-gates that (§4) and this module honours it: everything here is a READER.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db.js";

/**
 * How close to opening an unpromoted event has to be before it is worth an
 * operator email.
 *
 * ⚠️ Defined in SECONDS against `start_date`, not in truncated days, and the
 * distinction is not pedantic: measured on live data 2026-08-28, counting with
 * `CAST(days AS INT) <= 14` returns SIX rows while an exact 14×86400 window
 * returns FOUR. The two extra sit between 14.0 and 15.0 days out. A test
 * written against one and a query against the other disagree at the boundary
 * and look like a flake.
 */
export const IMMINENT_DAYS = 14;
export const IMMINENT_SECONDS = IMMINENT_DAYS * 86400;

/**
 * Promotion readiness, as three auditable tiers rather than one opaque score.
 *
 * OPE-611 §3 asks for the rule to be WRITTEN DOWN rather than left to
 * per-session judgment, and a numeric score does not satisfy that — a reviewer
 * cannot tell why 0.72 was enough. A tier states its own reason.
 *
 * `ready` is exactly the §4 auto-promotion shape. It is computed and reported
 * here so the proposal can be argued against real counts, but NOTHING in this
 * module acts on it. On 2026-08-28 it selects 37 of the 164 upcoming rows.
 */
export type ReadinessTier =
  /** dates_confirmed=1 AND an active official_website citation AND no gate flags. */
  | "ready"
  /** Organizer-grade provenance, but one of the other two conditions is unmet. */
  | "probable"
  /** No active official_website citation — a human has to source this one. */
  | "unverified";

export interface TentativeQueueRow {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  daysOut: number;
  viewCount: number;
  datesConfirmed: boolean;
  gateFlags: string | null;
  officialCitations: number;
  anyCitations: number;
  tier: ReadinessTier;
}

/** Row shape as it comes back from D1, before tiering. */
interface RawRow {
  id: string;
  slug: string;
  name: string;
  start_date: number | null;
  view_count: number | null;
  dates_confirmed: number | null;
  gate_flags: string | null;
  official_citations: number | null;
  any_citations: number | null;
}

/**
 * The tier rule, pure and exported so a test can pin each boundary
 * independently of the query that feeds it.
 *
 * `gate_flags` is load-bearing on `ready` and is not decoration: live example,
 * Kefi Greek Festival 2026 carries `["name_em_dash_subvenue"]` alongside
 * `dates_confirmed=1` and an official citation. It is exactly the row an
 * auto-promotion rule must NOT take, and without the gate-flag clause it would
 * be the rule's best-looking candidate.
 */
export function readinessTier(input: {
  datesConfirmed: boolean;
  officialCitations: number;
  gateFlags: string | null;
}): ReadinessTier {
  if (input.officialCitations <= 0) return "unverified";
  if (input.datesConfirmed && !input.gateFlags) return "ready";
  return "probable";
}

/**
 * Upcoming APPROVED + TENTATIVE events, ranked by promotion readiness.
 *
 * Ranking is tier first, then soonest, then most-viewed — so the operator's
 * attention goes to the rows that are both defensible and about to matter,
 * which is the order in which the gem show would have surfaced.
 */
export async function readTentativePromotionQueue(
  db: Db,
  now: Date = new Date(),
  opts: { withinSeconds?: number; limit?: number } = {}
): Promise<TentativeQueueRow[]> {
  const nowSecs = Math.floor(now.getTime() / 1000);
  const cutoff = opts.withinSeconds != null ? nowSecs + opts.withinSeconds : null;
  const limit = opts.limit ?? 200;

  // Raw SQL for the two correlated citation counts: expressing them as drizzle
  // subqueries costs two extra round trips per row, and this runs on a cron
  // over a few hundred rows.
  const rows = await db.all<RawRow>(sql`
    SELECT e.id, e.slug, e.name, e.start_date, e.view_count,
           e.dates_confirmed, e.gate_flags,
           (SELECT COUNT(*) FROM event_data_citations c
             WHERE c.event_id = e.id AND c.state = 'active'
               AND c.source_type = 'official_website')  AS official_citations,
           (SELECT COUNT(*) FROM event_data_citations c
             WHERE c.event_id = e.id AND c.state = 'active') AS any_citations
      FROM events e
     WHERE e.status = 'APPROVED'
       AND e.lifecycle_status = 'TENTATIVE'
       AND e.start_date IS NOT NULL
       AND e.start_date >= ${nowSecs}
       ${cutoff == null ? sql`` : sql`AND e.start_date <= ${cutoff}`}
     ORDER BY e.start_date ASC
     LIMIT ${limit}
  `);

  return rows
    .map((r): TentativeQueueRow => {
      const officialCitations = Number(r.official_citations ?? 0);
      const datesConfirmed = Number(r.dates_confirmed ?? 0) === 1;
      // Treat an empty-string gate_flags as absent. `NOT(... LIKE ...)` on NULL
      // has bitten this project before; here the equivalent trap is `""` being
      // falsy in JS but present in SQL, so normalise once at the boundary.
      const gateFlags = r.gate_flags && r.gate_flags.length > 0 ? r.gate_flags : null;
      const startSecs = r.start_date == null ? null : Number(r.start_date);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        startDate: startSecs == null ? null : new Date(startSecs * 1000),
        daysOut: startSecs == null ? 0 : Math.floor((startSecs - nowSecs) / 86400),
        viewCount: Number(r.view_count ?? 0),
        datesConfirmed,
        gateFlags,
        officialCitations,
        anyCitations: Number(r.any_citations ?? 0),
        tier: readinessTier({ datesConfirmed, officialCitations, gateFlags }),
      };
    })
    .sort((a, b) => {
      const rank = { ready: 0, probable: 1, unverified: 2 } as const;
      if (rank[a.tier] !== rank[b.tier]) return rank[a.tier] - rank[b.tier];
      if (a.daysOut !== b.daysOut) return a.daysOut - b.daysOut;
      return b.viewCount - a.viewCount;
    });
}

/**
 * The subset worth waking the operator for.
 *
 * ── Why imminence and NOT "the cohort exceeds a threshold" ──────────────────
 * The ticket offers both triggers. Only this one is built, deliberately.
 *
 * A backlog-size threshold fires every day forever: 51 rows carry organizer
 * citations today and the number moves slowly, so "51 > 20" would be true every
 * morning until the backlog is drained by hand. `operator-queue-notice.ts`
 * already records the rule this violates — a WORK QUEUE whose steady count
 * means "seen, not yet got to" must not re-nag, because that is what trains
 * someone to filter the sender. (An INVARIANT is the opposite case and does
 * nag daily; that is the OPE-510 canary, and the distinction is deliberate.)
 *
 * Imminence is self-clearing: a row leaves this set by being promoted, or by
 * the event starting. Measured on live data it selects FOUR rows today, which
 * is a list an operator can act on rather than a number they learn to ignore.
 * The 51-row backlog is exposed through the reader above for a deliberate
 * drain — surfaced, not pushed.
 *
 * `unverified` rows are excluded: with no organizer-grade citation there is
 * nothing for the operator to act ON, so including them would restore exactly
 * the wallpaper problem this avoids.
 */
export function selectImminentTentative(rows: TentativeQueueRow[]): TentativeQueueRow[] {
  return rows.filter(
    (r) => r.tier !== "unverified" && r.daysOut <= IMMINENT_DAYS && r.daysOut >= 0
  );
}

/** One human-readable line per row, for the operator email. */
export function formatTentativeLine(r: TentativeQueueRow): string {
  const cite = `${r.officialCitations} official citation${r.officialCitations === 1 ? "" : "s"}`;
  const gate = r.gateFlags ? `, gate ${r.gateFlags}` : "";
  const conf = r.datesConfirmed ? "dates confirmed" : "dates UNconfirmed";
  return (
    `TENTATIVE ${r.daysOut}d out — ${r.name} (${r.slug}) — ` +
    `${r.tier}: ${conf}, ${cite}${gate}, ${r.viewCount} views`
  );
}
