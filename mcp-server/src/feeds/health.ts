/**
 * OPE-1633 — feed analytics 2/5: feed health. MEASURE AND FLAG ONLY.
 *
 * A feed fails loudly (the read errors; OPE-1626 backs off and switches it off
 * after 5) or quietly: the read returns 200 but the site changed, and we now
 * get 0 items, half the items, or items with empty fields. These checks watch
 * for the quiet failure. They never send email and never change a feed
 * setting; a tripped check writes one open `feed_health_flags` row, and a later
 * evaluation back within bounds clears it.
 *
 * The checks (thresholds below):
 *   freshness       — no successful read in more than 2 × poll_interval_hours.
 *                     Evaluated by the hourly poll for EVERY enabled feed (a
 *                     stale feed is the one not being read), not after a read.
 *   volume_drop     — on a good read: items < 50% of the median of the last 8
 *                     good reads, OR 0 items after any of the last 4 was > 0.
 *                     A seasonal feed that has only ever read 0 never trips.
 *   format_drift    — (a) a failed read that is neither an HTTP status nor a
 *                     transport failure (timeout / network): the body did not
 *                     parse as the feed's kind — e.g. a TEC REST endpoint
 *                     answering HTML; (b) more unmappable items than the
 *                     feed's own baseline maximum; (c) a key field's fill
 *                     share (title, start date, venue) more than 30 points
 *                     below its baseline mean.
 *   inclusion_swing — the share dropped by rules rises more than 30 points
 *                     above the baseline mean.
 *
 * Baseline = the feed's last 8 good (outcome='ok') reads BEFORE this one.
 * A check with no baseline, or a read that cannot evaluate it (a 304 carries no
 * items), is NOT evaluated and leaves its flag as it is — an unevaluated check
 * is neither a trip nor a clear.
 *
 * `evaluateReadHealth` and `evaluateFreshness` are pure; `applyHealthResults`
 * is the only writer.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  feedHealthFlags,
  promoterEventFeeds,
  promoterFeedReads,
  type FeedHealthCheck,
} from "../schema.js";
import type { Db } from "../db.js";

const HOUR_MS = 3_600_000;

export const HEALTH_BASELINE_READS = 8;
export const VOLUME_DROP_RATIO = 0.5;
export const VOLUME_ZERO_LOOKBACK = 4;
/** 30 percentage points, as a share. */
export const SHARE_SWING = 0.3;
export const FRESHNESS_POLL_MULTIPLE = 2;
/** The hourly poll's evidence row for the `feed-health-eval` heartbeat probe. */
export const FEED_HEALTH_SOURCE = "feeds:health-eval";

/** One read, as the checks see it. Fill counts / unmappable are null when unmeasured. */
export interface ReadSample {
  outcome: "ok" | "not_modified" | "error" | "skipped";
  itemsRead: number;
  included: number;
  titleFilled: number | null;
  startFilled: number | null;
  venueFilled: number | null;
  unmappable: number | null;
  httpStatus: number | null;
  error: string | null;
}

export interface HealthResult {
  check: FeedHealthCheck;
  tripped: boolean;
  observed: number | null;
  baseline: number | null;
  detail: string;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/**
 * "More than 30 points". The epsilon matters: 1 − 0.7 is 0.30000000000000004
 * in floating point, which would put a swing of exactly 30 points over the line.
 */
const overSwing = (diff: number) => diff - SHARE_SWING > 1e-9;

/**
 * A failure that says nothing about the body: an HTTP status, a timeout, or a
 * network error. Anything else (a JSON / iCalendar parse failure, an HTML page
 * where a feed was expected) is format drift.
 */
export function isTransportFailure(message: string, httpStatus: number | null): boolean {
  if (httpStatus != null) return true;
  if (/\bHTTP \d{3}\b/.test(message)) return true;
  return /timed? ?out|timeout|abort|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket|TLS|certificate/i.test(
    message
  );
}

/**
 * The read-time checks, for one real read. `baseline` is the feed's previous
 * good reads, newest first (at most HEALTH_BASELINE_READS are used). Returns
 * only the checks this read could evaluate.
 */
export function evaluateReadHealth(current: ReadSample, baseline: ReadSample[]): HealthResult[] {
  const prior = baseline.filter((r) => r.outcome === "ok").slice(0, HEALTH_BASELINE_READS);
  const out: HealthResult[] = [];

  if (current.outcome === "error") {
    // (a) only. Volume and inclusion need items; an HTTP / transport failure
    // is the loud failure OPE-1626 already handles, so it leaves drift as is.
    const msg = current.error ?? "";
    if (!isTransportFailure(msg, current.httpStatus)) {
      out.push({
        check: "format_drift",
        tripped: true,
        observed: null,
        baseline: null,
        detail: `read failed to parse: ${msg}`.slice(0, 300),
      });
    }
    return out;
  }
  if (current.outcome !== "ok") return out; // 304 / skipped: nothing to evaluate

  const n = current.itemsRead;

  // volume_drop
  if (prior.length > 0) {
    const counts = prior.map((r) => r.itemsRead);
    const med = median(counts)!;
    const recentNonZero = counts.slice(0, VOLUME_ZERO_LOOKBACK).some((c) => c > 0);
    const belowMedian = n < VOLUME_DROP_RATIO * med;
    const zeroAfterSome = n === 0 && recentNonZero;
    out.push({
      check: "volume_drop",
      tripped: belowMedian || zeroAfterSome,
      observed: n,
      baseline: med,
      detail: zeroAfterSome
        ? `0 items; ${counts.slice(0, VOLUME_ZERO_LOOKBACK).join(", ")} on the last ${Math.min(VOLUME_ZERO_LOOKBACK, counts.length)} good reads`
        : `${n} items vs median ${med} of the last ${counts.length} good reads (trips under ${VOLUME_DROP_RATIO * 100}%)`,
    });
  }

  // format_drift (b) + (c) — evaluated on every good read that has a baseline
  // for at least one part, so a good parse after an (a) trip clears it.
  const drift: string[] = [];
  let worstDrop: { observed: number; baseline: number } | null = null;
  const unmBase = prior.map((r) => r.unmappable).filter((x): x is number => x != null);
  const unmEvaluated = current.unmappable != null && unmBase.length > 0;
  if (unmEvaluated && current.unmappable! > Math.max(...unmBase)) {
    drift.push(`${current.unmappable} unmappable items (baseline max ${Math.max(...unmBase)})`);
  }
  const fields = [
    ["title", "titleFilled"],
    ["start date", "startFilled"],
    ["venue", "venueFilled"],
  ] as const;
  let fillEvaluated = false;
  if (n > 0) {
    for (const [label, key] of fields) {
      const cur = current[key];
      if (cur == null) continue;
      const shares = prior
        .filter((r) => r[key] != null && r.itemsRead > 0)
        .map((r) => (r[key] as number) / r.itemsRead);
      const base = mean(shares);
      if (base == null) continue;
      fillEvaluated = true;
      const share = cur / n;
      if (overSwing(base - share)) {
        drift.push(
          `${label} filled on ${Math.round(share * 100)}% (baseline ${Math.round(base * 100)}%)`
        );
        if (!worstDrop || base - share > worstDrop.baseline - worstDrop.observed)
          worstDrop = { observed: round3(share), baseline: round3(base) };
      }
    }
  }
  if (unmEvaluated || fillEvaluated || prior.length > 0) {
    out.push({
      check: "format_drift",
      tripped: drift.length > 0,
      observed: worstDrop?.observed ?? current.unmappable,
      baseline: worstDrop?.baseline ?? (unmBase.length ? Math.max(...unmBase) : null),
      detail: drift.length ? drift.join("; ") : "parsed; key-field fill within baseline",
    });
  }

  // inclusion_swing
  if (n > 0) {
    const shares = prior
      .filter((r) => r.itemsRead > 0)
      .map((r) => (r.itemsRead - r.included) / r.itemsRead);
    const base = mean(shares);
    if (base != null) {
      const share = (n - current.included) / n;
      out.push({
        check: "inclusion_swing",
        tripped: overSwing(share - base),
        observed: round3(share),
        baseline: round3(base),
        detail: `${Math.round(share * 100)}% of items dropped by rules (baseline ${Math.round(base * 100)}%)`,
      });
    }
  }
  return out;
}

/**
 * freshness — the same deadline as the `feed-reader` heartbeat probe
 * (src/lib/heartbeat.ts `feedReaderEvidence`): due a good read by
 * `(last_ok_at ?? created_at) + 2 × max(1, poll_interval_hours)`.
 */
export function evaluateFreshness(
  feed: { lastOkAt: Date | null; createdAt: Date; pollIntervalHours: number },
  now: Date
): HealthResult {
  const from = feed.lastOkAt ?? feed.createdAt;
  const allowedH = FRESHNESS_POLL_MULTIPLE * Math.max(1, feed.pollIntervalHours);
  const ageH = (now.getTime() - from.getTime()) / HOUR_MS;
  return {
    check: "freshness",
    tripped: ageH > allowedH,
    observed: Math.round(ageH * 10) / 10,
    baseline: allowedH,
    detail: feed.lastOkAt
      ? `last good read ${Math.round(ageH)}h ago (allowed ${allowedH}h)`
      : `never read successfully; registered ${Math.round(ageH)}h ago (allowed ${allowedH}h)`,
  };
}

/** Counts for the run log, from the items a good read returned. */
export function fillCounts(
  items: Array<{ title?: string | null; startDate?: string | null; venue?: unknown }>
): { titleFilled: number; startFilled: number; venueFilled: number } {
  let titleFilled = 0;
  let startFilled = 0;
  let venueFilled = 0;
  for (const i of items) {
    if (typeof i.title === "string" && i.title.trim()) titleFilled++;
    if (i.startDate) startFilled++;
    if (i.venue != null) venueFilled++;
  }
  return { titleFilled, startFilled, venueFilled };
}

/** The feed's previous good reads, newest first, excluding `exceptId`. */
export async function loadHealthBaseline(
  db: Db,
  feedId: string,
  exceptId?: string
): Promise<ReadSample[]> {
  const r = promoterFeedReads;
  const rows = await db
    .select({
      outcome: r.outcome,
      itemsRead: r.itemsRead,
      included: r.included,
      titleFilled: r.titleFilled,
      startFilled: r.startFilled,
      venueFilled: r.venueFilled,
      unmappable: r.unmappable,
      httpStatus: r.httpStatus,
      error: r.error,
    })
    .from(r)
    .where(
      and(eq(r.feedId, feedId), eq(r.outcome, "ok"), exceptId ? ne(r.id, exceptId) : undefined)
    )
    .orderBy(desc(r.startedAt), desc(r.id))
    .limit(HEALTH_BASELINE_READS);
  return rows;
}

/**
 * The only writer. A tripped check opens (or refreshes) its one open row; an
 * evaluated check back in bounds clears it. Checks not in `results` are left
 * alone. Returns what changed.
 */
export async function applyHealthResults(
  db: Db,
  feedId: string,
  now: Date,
  results: HealthResult[]
): Promise<{
  opened: FeedHealthCheck[];
  refreshed: FeedHealthCheck[];
  cleared: FeedHealthCheck[];
}> {
  const changed = {
    opened: [] as FeedHealthCheck[],
    refreshed: [] as FeedHealthCheck[],
    cleared: [] as FeedHealthCheck[],
  };
  if (results.length === 0) return changed;
  const f = feedHealthFlags;
  const open = await db
    .select({ id: f.id, check: f.checkName })
    .from(f)
    .where(
      and(
        eq(f.feedId, feedId),
        isNull(f.clearedAt),
        inArray(
          f.checkName,
          results.map((r) => r.check)
        )
      )
    );
  const openBy = new Map(open.map((o) => [o.check, o.id]));
  for (const r of results) {
    const id = openBy.get(r.check);
    if (r.tripped) {
      if (id) {
        await db
          .update(f)
          .set({ lastSeenAt: now, observed: r.observed, baseline: r.baseline, detail: r.detail })
          .where(eq(f.id, id));
        changed.refreshed.push(r.check);
      } else {
        await db.insert(f).values({
          id: crypto.randomUUID(),
          feedId,
          checkName: r.check,
          observed: r.observed,
          baseline: r.baseline,
          detail: r.detail,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        changed.opened.push(r.check);
      }
    } else if (id) {
      await db.update(f).set({ clearedAt: now }).where(eq(f.id, id));
      changed.cleared.push(r.check);
    }
  }
  return changed;
}

/**
 * The hourly poll's freshness pass over every ENABLED feed. Returns the counts
 * for its evidence row.
 */
export async function evaluateFreshnessAll(
  db: Db,
  now: Date
): Promise<{ evaluated: number; stale: number; open: number }> {
  const feeds = await db
    .select({
      id: promoterEventFeeds.id,
      lastOkAt: promoterEventFeeds.lastOkAt,
      createdAt: promoterEventFeeds.createdAt,
      pollIntervalHours: promoterEventFeeds.pollIntervalHours,
    })
    .from(promoterEventFeeds)
    .where(eq(promoterEventFeeds.enabled, true));
  let stale = 0;
  for (const feed of feeds) {
    const r = evaluateFreshness(feed, now);
    if (r.tripped) stale++;
    await applyHealthResults(db, feed.id, now, [r]);
  }
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(feedHealthFlags)
    .innerJoin(promoterEventFeeds, eq(promoterEventFeeds.id, feedHealthFlags.feedId))
    .where(and(isNull(feedHealthFlags.clearedAt), eq(promoterEventFeeds.enabled, true)));
  return { evaluated: feeds.length, stale, open: Number(n) };
}
