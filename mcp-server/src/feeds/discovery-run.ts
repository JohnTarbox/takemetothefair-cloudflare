/**
 * OPE-1636 part B — the monthly feed discovery run (MCP hourly cron).
 *
 * Each hourly fire probes a small slice of ELIGIBLE promoters — a website, no
 * registered feed, not yet probed this month — never-probed promoters first, so
 * a month that runs out before the list does carries on next month where it
 * stopped ("spread across months if needed"). A run closes when nobody eligible
 * is left, or at the first fire of the next month (a partial close: `probed` <
 * `eligible`). The Worker cannot file Linear issues (OPE-76's rail), so an agent
 * session files the "Feed discovery, month of …" analyst task from
 * list_feed_discovery_runs and stamps it with record_feed_discovery_filing.
 *
 * Writes only feed_discovery_runs / feed_discovery_probes. Never events.
 */
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { matchableDomainsFor } from "@takemetothefair/db-schema";
import {
  feedDiscoveryProbes,
  feedDiscoveryRuns,
  promoterEventFeeds,
  promoters,
  type FeedDiscoveryOutcome,
} from "../schema.js";
import type { Db } from "../db.js";
import { probeDomain, type FeedDiscoveryCandidate } from "./discovery.js";

/** Promoters probed per hourly fire. 816 eligible on 2026-11-26 → ~3 days. */
export const FEED_DISCOVERY_BATCH = 12;
/** Promoters probed at once (each on its own host). */
const CONCURRENCY = 4;
/** Domains probed per promoter, from its domain list. */
const MAX_DOMAINS = 3;

export const monthOf = (d: Date) => d.toISOString().slice(0, 7);

export interface PromoterProbe {
  promoter_id: string;
  promoter: string | null;
  domains: string[];
  outcome: FeedDiscoveryOutcome;
  candidates: Array<FeedDiscoveryCandidate & { domain: string }>;
  requests: number;
  detail: string | null;
}

const RANK: Record<FeedDiscoveryOutcome, number> = {
  found: 4,
  blocked: 3,
  error: 2,
  none: 1,
  no_domain: 0,
};

/** Probe one promoter's own domains. Reads only; never throws. */
export async function probePromoter(
  db: Db,
  promoterId: string,
  opts: { now: Date; fetchImpl?: typeof fetch }
): Promise<PromoterProbe> {
  const [p] = await db
    .select({ name: promoters.companyName })
    .from(promoters)
    .where(eq(promoters.id, promoterId))
    .limit(1);
  const domains = (await matchableDomainsFor(db, "promoter", promoterId)).slice(0, MAX_DOMAINS);
  const out: PromoterProbe = {
    promoter_id: promoterId,
    promoter: p?.name ?? null,
    domains,
    outcome: "no_domain",
    candidates: [],
    requests: 0,
    detail: domains.length ? null : "no matchable domain on the promoter's domain list",
  };
  const details: string[] = [];
  for (const domain of domains) {
    const r = await probeDomain(domain, opts);
    out.requests += r.requests;
    out.candidates.push(...r.candidates.map((c) => ({ ...c, domain })));
    if (RANK[r.outcome] > RANK[out.outcome]) out.outcome = r.outcome;
    if (r.detail) details.push(`${domain}: ${r.detail}`);
  }
  if (out.candidates.length) out.outcome = "found";
  if (details.length) out.detail = details.join("; ");
  return out;
}

/** Eligible promoter ids for `month`, never-probed first, then oldest probe. */
export async function eligiblePromoterIds(db: Db, month: string, limit: number): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`
    SELECT p.id FROM promoters p
    WHERE p.website IS NOT NULL AND trim(p.website) <> ''
      AND NOT EXISTS (SELECT 1 FROM promoter_event_feeds f WHERE f.promoter_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM feed_discovery_probes d WHERE d.promoter_id = p.id AND d.month = ${month})
    ORDER BY (SELECT max(d2.probed_at) FROM feed_discovery_probes d2 WHERE d2.promoter_id = p.id) IS NOT NULL,
      (SELECT max(d3.probed_at) FROM feed_discovery_probes d3 WHERE d3.promoter_id = p.id),
      p.id
    LIMIT ${limit}`);
  return rows.map((r) => r.id);
}

async function countEligible(db: Db, month: string): Promise<number> {
  const [r] = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM promoters p
    WHERE p.website IS NOT NULL AND trim(p.website) <> ''
      AND NOT EXISTS (SELECT 1 FROM promoter_event_feeds f WHERE f.promoter_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM feed_discovery_probes d WHERE d.promoter_id = p.id AND d.month = ${month})`);
  return Number(r?.n ?? 0);
}

async function refreshCounts(db: Db, month: string, now: Date, complete: boolean) {
  const [c] = await db.all<{ probed: number; found: number }>(sql`
    SELECT COUNT(*) AS probed, SUM(CASE WHEN outcome = 'found' THEN 1 ELSE 0 END) AS found
    FROM feed_discovery_probes WHERE month = ${month}`);
  await db
    .update(feedDiscoveryRuns)
    .set({
      probed: Number(c?.probed ?? 0),
      found: Number(c?.found ?? 0),
      updatedAt: now,
      ...(complete ? { completedAt: now } : {}),
    })
    .where(eq(feedDiscoveryRuns.month, month));
}

async function recordProbe(db: Db, month: string, r: PromoterProbe, now: Date) {
  const values = {
    promoterId: r.promoter_id,
    month,
    probedAt: now,
    outcome: r.outcome,
    domains: JSON.stringify(r.domains),
    candidates: JSON.stringify(r.candidates),
    candidateCount: r.candidates.length,
    detail: r.detail,
  };
  await db
    .insert(feedDiscoveryProbes)
    .values(values)
    .onConflictDoUpdate({
      target: [feedDiscoveryProbes.promoterId, feedDiscoveryProbes.month],
      set: { ...values },
    });
}

export interface DiscoverySliceResult {
  month: string;
  closed_previous: string[];
  probed: number;
  completed: boolean;
}

/**
 * One hourly fire. Closes any earlier month still open (partial), opens this
 * month's run, probes up to `batch` eligible promoters, and closes the run when
 * none is left. Idempotent per promoter-month (unique index).
 */
export async function runFeedDiscoverySlice(
  db: Db,
  now: Date,
  opts: { batch?: number; fetchImpl?: typeof fetch } = {}
): Promise<DiscoverySliceResult> {
  const month = monthOf(now);
  const stale = await db
    .select({ month: feedDiscoveryRuns.month })
    .from(feedDiscoveryRuns)
    .where(and(isNull(feedDiscoveryRuns.completedAt), lt(feedDiscoveryRuns.month, month)));
  for (const s of stale) await refreshCounts(db, s.month, now, true);

  const [run] = await db
    .select()
    .from(feedDiscoveryRuns)
    .where(eq(feedDiscoveryRuns.month, month))
    .limit(1);
  if (run?.completedAt) {
    return { month, closed_previous: stale.map((s) => s.month), probed: 0, completed: true };
  }
  if (!run) {
    await db
      .insert(feedDiscoveryRuns)
      .values({ month, startedAt: now, eligible: await countEligible(db, month), updatedAt: now })
      .onConflictDoNothing();
  }

  const ids = await eligiblePromoterIds(db, month, opts.batch ?? FEED_DISCOVERY_BATCH);
  if (ids.length === 0) {
    await refreshCounts(db, month, now, true);
    return { month, closed_previous: stale.map((s) => s.month), probed: 0, completed: true };
  }
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const results = await Promise.all(
      ids
        .slice(i, i + CONCURRENCY)
        .map((id) => probePromoter(db, id, { now, fetchImpl: opts.fetchImpl }))
    );
    for (const r of results) await recordProbe(db, month, r, now);
  }
  await refreshCounts(db, month, now, false);
  return {
    month,
    closed_previous: stale.map((s) => s.month),
    probed: ids.length,
    completed: false,
  };
}

// ── Reading and filing ───────────────────────────────────────────────────────

export interface DiscoveryRunView {
  month: string;
  started_at: string;
  completed_at: string | null;
  partial: boolean;
  eligible: number;
  probed: number;
  found: number;
  ope_id: string | null;
  filed_at: string | null;
  /** Candidates first seen this month (feed URLs no earlier month found for that promoter), unregistered promoters only. */
  new_candidates: Array<{
    promoter_id: string;
    promoter: string | null;
    website: string | null;
    candidates: Array<FeedDiscoveryCandidate & { domain: string }>;
  }>;
  blocked: Array<{ promoter_id: string; promoter: string | null; detail: string | null }>;
}

export async function listFeedDiscoveryRuns(db: Db, opts: { month?: string; limit?: number } = {}) {
  const runs = await db
    .select()
    .from(feedDiscoveryRuns)
    .where(opts.month ? eq(feedDiscoveryRuns.month, opts.month) : undefined)
    .orderBy(desc(feedDiscoveryRuns.month))
    .limit(opts.limit ?? 3);
  const out: DiscoveryRunView[] = [];
  for (const r of runs) {
    const probes = await db
      .select({
        promoterId: feedDiscoveryProbes.promoterId,
        outcome: feedDiscoveryProbes.outcome,
        candidates: feedDiscoveryProbes.candidates,
        detail: feedDiscoveryProbes.detail,
        promoter: promoters.companyName,
        website: promoters.website,
        registered: sql<number>`EXISTS (SELECT 1 FROM ${promoterEventFeeds} f WHERE f.promoter_id = ${feedDiscoveryProbes.promoterId})`,
        earlier: sql<
          string | null
        >`(SELECT group_concat(e.candidates, '') FROM ${feedDiscoveryProbes} e
          WHERE e.promoter_id = ${feedDiscoveryProbes.promoterId} AND e.month < ${r.month})`,
      })
      .from(feedDiscoveryProbes)
      .leftJoin(promoters, eq(promoters.id, feedDiscoveryProbes.promoterId))
      .where(eq(feedDiscoveryProbes.month, r.month))
      .orderBy(promoters.companyName);
    const newCandidates: DiscoveryRunView["new_candidates"] = [];
    const blocked: DiscoveryRunView["blocked"] = [];
    for (const p of probes) {
      if (p.outcome === "blocked")
        blocked.push({ promoter_id: p.promoterId, promoter: p.promoter, detail: p.detail });
      if (p.outcome !== "found" || Number(p.registered) === 1) continue;
      const cands = JSON.parse(
        p.candidates
      ) as DiscoveryRunView["new_candidates"][number]["candidates"];
      const fresh = cands.filter((c) => !(p.earlier ?? "").includes(JSON.stringify(c.feed_url)));
      if (fresh.length)
        newCandidates.push({
          promoter_id: p.promoterId,
          promoter: p.promoter,
          website: p.website,
          candidates: fresh,
        });
    }
    out.push({
      month: r.month,
      started_at: r.startedAt.toISOString(),
      completed_at: r.completedAt?.toISOString() ?? null,
      partial: !!r.completedAt && r.probed < r.eligible,
      eligible: r.eligible,
      probed: r.probed,
      found: r.found,
      ope_id: r.opeId,
      filed_at: r.filedAt?.toISOString() ?? null,
      new_candidates: newCandidates,
      blocked,
    });
  }
  return out;
}

export type DiscoveryFilingResult =
  { ok: true; month: string; ope_id: string; changed: boolean } | { ok: false; reason: string };

/** Stamp a run with the analyst task filed for it. Never overwrites a different id. */
export async function recordFeedDiscoveryFiling(
  db: Db,
  month: string,
  opeId: string,
  now: Date
): Promise<DiscoveryFilingResult> {
  const [r] = await db
    .select()
    .from(feedDiscoveryRuns)
    .where(eq(feedDiscoveryRuns.month, month))
    .limit(1);
  if (!r) return { ok: false, reason: `no feed discovery run for ${month}` };
  if (r.opeId === opeId) return { ok: true, month, ope_id: opeId, changed: false };
  if (r.opeId)
    return { ok: false, reason: `${month} is already filed as ${r.opeId}; not overwritten` };
  await db
    .update(feedDiscoveryRuns)
    .set({ opeId, filedAt: now, updatedAt: now })
    .where(and(eq(feedDiscoveryRuns.month, month), isNull(feedDiscoveryRuns.opeId)));
  return { ok: true, month, ope_id: opeId, changed: true };
}

// ── The discovery funnel ─────────────────────────────────────────────────────

export interface DiscoveryFunnel {
  probed: number;
  feed_found: number;
  registered: number;
  healthy: number;
  producing_new_to_us: number;
  formulas: Record<string, string>;
}

/** probed → feed found → registered → healthy → producing "new to us" events, over all months. */
export async function loadDiscoveryFunnel(db: Db, now: Date): Promise<DiscoveryFunnel> {
  const nowS = Math.floor(now.getTime() / 1000);
  const [r] = await db.all<Record<string, number>>(sql`
    WITH probed AS (SELECT DISTINCT promoter_id FROM feed_discovery_probes),
      found AS (SELECT DISTINCT promoter_id FROM feed_discovery_probes WHERE outcome = 'found'),
      registered AS (SELECT DISTINCT f.promoter_id FROM promoter_event_feeds f JOIN found USING (promoter_id)),
      healthy AS (SELECT DISTINCT f.promoter_id FROM promoter_event_feeds f JOIN found USING (promoter_id)
        WHERE f.enabled = 1 AND f.last_ok_at IS NOT NULL
          AND ${nowS} - f.last_ok_at <= max(24, 2 * f.poll_interval_hours) * 3600),
      producing AS (SELECT DISTINCT f.promoter_id FROM promoter_event_feeds f JOIN found USING (promoter_id)
        JOIN promoter_feed_items i ON i.feed_id = f.id
        WHERE i.link_basis = 'review_approve' OR (i.review_state = 'awaiting_review' AND i.event_id IS NULL))
    SELECT (SELECT COUNT(*) FROM probed) AS probed, (SELECT COUNT(*) FROM found) AS feed_found,
      (SELECT COUNT(*) FROM registered) AS registered, (SELECT COUNT(*) FROM healthy) AS healthy,
      (SELECT COUNT(*) FROM producing) AS producing_new_to_us`);
  return {
    probed: Number(r?.probed ?? 0),
    feed_found: Number(r?.feed_found ?? 0),
    registered: Number(r?.registered ?? 0),
    healthy: Number(r?.healthy ?? 0),
    producing_new_to_us: Number(r?.producing_new_to_us ?? 0),
    formulas: {
      probed: "distinct promoters with any feed_discovery_probes row",
      feed_found: "of those, promoters a probe found a candidate for (outcome 'found')",
      registered: "of those, promoters with a registered feed (promoter_event_feeds)",
      healthy:
        "of those, an enabled feed read OK within max(24h, 2 × poll interval) — the lane's healthy rule",
      producing_new_to_us:
        "of those, a feed with an item new to us: approved from the feed (link_basis review_approve) or awaiting review with no listing",
    },
  };
}
