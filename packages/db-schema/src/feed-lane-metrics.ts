/**
 * OPE-1632 — feed analytics 1/5: the organizer-feed funnel, review backlog,
 * lead time, coverage and change capture. READ-ONLY; it changes nothing.
 *
 * Three callers, one definition, so the numbers cannot drift between them:
 *   - the MCP tool `get_feed_lane_metrics`;
 *   - the /admin dashboard's "Organizer feeds" tile;
 *   - the feeds line in the daily operator digest (operator-queue-notice).
 *
 * The split follows promoter-outreach-metrics: `buildFeedLaneMetrics` is pure
 * arithmetic over plain rows (tested without a database), and
 * `loadFeedLaneMetrics` only fetches those rows. Every number in the output
 * carries its formula, and a number that cannot be computed is `null` with a
 * reason — never 0. "Nobody has reviewed anything" and "we cannot measure
 * reviews yet" are different facts and must read differently.
 *
 * ── What "matched" means (measured against prod, 2026-11-11) ──────────────
 * The ingest links EVERY item it can match, whether or not the inclusion
 * filter picked it (an item matching a live page stays watched even if a rule
 * would have excluded it). Saco Main Street's two linked items are one
 * included and one excluded by the `kids` rule. So "matched" counts every
 * item with an event, and `matched_outside_filter` names the excluded ones;
 * "dropped" is excluded AND unmatched (review_state = 'dropped').
 */
import { and, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";
import {
  eventDiscrepancies,
  events,
  feedHealthFlags,
  promoterEventFeeds,
  promoterFeedItems,
  promoters,
} from "./index";
import { upcomingEndPredicate } from "./event-end-predicates";

type Db = DrizzleD1Database<typeof schema>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The ticket's default review target. */
export const FEED_REVIEW_TARGET_DAYS = 3;
/** "Reached us late": fewer than this many days before the event. */
export const FEED_LATE_LEAD_DAYS = 14;
/** The discrepancy detector the feed ingest writes under (mcp-server feeds/ingest.ts). */
export const FEED_DISCREPANCY_DETECTOR = "organizer_feed" as const;
/** A feed is healthy if it read OK within this many poll intervals (and at least this many hours). */
const HEALTHY_POLL_MULTIPLE = 2;
const HEALTHY_MIN_HOURS = 24;

/**
 * Until OPE-1630 (feed review step) ships there is no record of a review, so
 * reviewed / approved / rejected are NOT MEASURED — never 0.
 */
export const REVIEW_NOT_MEASURED_REASON =
  "not yet measured: the feed review step (OPE-1630) has not shipped, so no review is recorded";

// ── Inputs (plain rows) ──────────────────────────────────────────────────────

export interface FeedRow {
  id: string;
  promoterId: string;
  promoterName: string | null;
  url: string;
  enabled: boolean;
  lastOkAt: Date | null;
  pollIntervalHours: number;
  consecutiveErrors: number;
}

export interface FeedItemRow {
  feedId: string;
  eventId: string | null;
  included: boolean;
  exclusionReason: string | null;
  reviewState: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** "YYYY-MM-DD[ HH:MM]" in the event's local time, or null. */
  startLocal: string | null;
  missingSince: Date | null;
  /** Whether the linked event passes the public-visibility gate; null when unlinked. */
  eventPublic: boolean | null;
}

export interface FeedChangeRow {
  eventId: string;
  promoterId: string | null;
  kind: string | null;
  detectedAt: Date;
  /** The event's start date, for "caught before the event". */
  eventStart: Date | null;
}

export interface CoverageRow {
  promoterId: string | null;
  /** events.ingestion_method, or null. */
  ingestionMethod: string | null;
  /** True when some feed item links to this event. */
  feedLinked: boolean;
}

/** OPE-1633 — one OPEN feed health flag (feed_health_flags, cleared_at IS NULL). */
export interface FeedHealthFlagRow {
  feedId: string;
  check: string;
  detail: string | null;
  firstSeenAt: Date;
}

export interface FeedLaneInput {
  now: Date;
  /** OPE-1633 — open health flags; omitted = none. */
  flags?: FeedHealthFlagRow[];
  windowDays: number;
  targetDays?: number;
  feeds: FeedRow[];
  items: FeedItemRow[];
  changes: FeedChangeRow[];
  /** Upcoming public events — whole site, or the one promoter's when filtered. */
  coverage: CoverageRow[];
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface Metric {
  value: number | null;
  formula: string;
  /** Present only when value is null. */
  reason?: string;
}

export interface FunnelStep {
  step: string;
  count: number | null;
  /** count / the named base, 0..1; null when the base is 0 or the count is unmeasured. */
  rate: number | null;
  rate_base: string | null;
  formula: string;
  reason?: string;
}

export interface FeedFunnel {
  steps: FunnelStep[];
  dropped_by_rule: Array<{ rule: string; count: number }>;
  matched_outside_filter: number;
}

export interface FeedLaneSection {
  funnel: FeedFunnel;
  backlog: {
    awaiting_review: Metric;
    oldest_age_days: Metric;
    median_age_days: Metric;
    older_than_target: Metric;
    target_days: number;
  };
  lead_time: { median_days: Metric; share_under_14_days: Metric };
  change_capture: { detected: Metric; cancellations: Metric; before_event: Metric };
}

export interface FeedLaneMetrics {
  generated_at: string;
  window: { days: number; since: string; rule: string };
  feeds: {
    registered: number;
    enabled: number;
    healthy: number;
    healthy_rule: string;
    /** OPE-1633 — open health flags on ENABLED feeds, oldest first. */
    open_health_flags: Array<{
      feed_id: string;
      promoter: string | null;
      check: string;
      detail: string | null;
      first_seen_at: string;
    }>;
  };
  total: FeedLaneSection;
  coverage: {
    upcoming_public_events: number;
    share_with_healthy_feed: Metric;
    share_feed_linked: Metric;
    by_ingestion_method: Array<{ method: string; count: number }>;
    new_to_us: Metric;
    new_to_us_7d: Metric;
  };
  per_feed: Array<
    {
      feed_id: string;
      promoter_id: string;
      promoter: string | null;
      url: string;
      enabled: boolean;
      healthy: boolean;
    } & FeedLaneSection
  >;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const rate = (n: number | null, base: number): number | null =>
  n == null || base <= 0 ? null : Math.round((n / base) * 1000) / 1000;

export function isFeedHealthy(f: FeedRow, now: Date): boolean {
  if (!f.enabled || !f.lastOkAt) return false;
  const maxAgeMs =
    Math.max(HEALTHY_MIN_HOURS, HEALTHY_POLL_MULTIPLE * f.pollIntervalHours) * HOUR_MS;
  return now.getTime() - f.lastOkAt.getTime() <= maxAgeMs;
}

/** The event date of an item as UTC midnight of its local date, or null. */
function itemDateMs(startLocal: string | null): number | null {
  if (!startLocal || !/^\d{4}-\d{2}-\d{2}/.test(startLocal)) return null;
  return Date.parse(`${startLocal.slice(0, 10)}T00:00:00Z`);
}

/** A UTC day number, so day-granular comparisons ignore the time of day. */
const dayOf = (ms: number) => Math.floor(ms / DAY_MS);

/** Is this awaiting-review item still a live review task? (The digest's definition, OPE-1626.) */
function isLiveReview(i: FeedItemRow, today: string): boolean {
  return (
    i.reviewState === "awaiting_review" &&
    i.missingSince === null &&
    i.startLocal !== null &&
    i.startLocal >= today
  );
}

function buildSection(
  items: FeedItemRow[],
  liveFeedIds: Set<string>,
  changes: FeedChangeRow[],
  now: Date,
  since: Date,
  targetDays: number
): FeedLaneSection {
  const inWindow = items.filter((i) => i.lastSeenAt.getTime() >= since.getTime());
  const read = inWindow.length;
  const included = inWindow.filter((i) => i.included).length;
  const droppedRows = inWindow.filter((i) => i.reviewState === "dropped");
  const matched = inWindow.filter((i) => i.eventId !== null);
  const matchedOutside = matched.filter((i) => !i.included).length;
  const fresh = inWindow.filter((i) => i.reviewState === "awaiting_review").length;
  const published = matched.filter((i) => i.eventPublic === true).length;

  const byRule = new Map<string, number>();
  for (const d of droppedRows) {
    const rule = d.exclusionReason ?? "(no reason recorded)";
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }

  const notMeasured = (step: string, base: string): FunnelStep => ({
    step,
    count: null,
    rate: null,
    rate_base: base,
    formula: `${step}: review actions recorded on items in the window`,
    reason: REVIEW_NOT_MEASURED_REASON,
  });

  const steps: FunnelStep[] = [
    {
      step: "read",
      count: read,
      rate: null,
      rate_base: null,
      formula: "distinct feed items carried by a read in the window (last_seen_at >= since)",
    },
    {
      step: "included",
      count: included,
      rate: rate(included, read),
      rate_base: "read",
      formula: "read items the inclusion rules picked (included = 1)",
    },
    {
      step: "dropped",
      count: droppedRows.length,
      rate: rate(droppedRows.length, read),
      rate_base: "read",
      formula: "read items the rules excluded and that match no event (review_state = 'dropped')",
    },
    {
      step: "matched",
      count: matched.length,
      rate: rate(matched.length, read),
      rate_base: "read",
      formula:
        "read items linked to an existing event (event_id set), included or not — see matched_outside_filter",
    },
    {
      step: "new",
      count: fresh,
      rate: rate(fresh, included),
      rate_base: "included",
      formula: "included items matching no event (review_state = 'awaiting_review')",
    },
    notMeasured("reviewed", "new"),
    notMeasured("approved", "reviewed"),
    notMeasured("rejected", "reviewed"),
    {
      step: "published",
      count: published,
      rate: rate(published, matched.length),
      rate_base: "matched",
      formula: "matched items whose event passes the public-visibility gate (publicEventWhere)",
    },
  ];

  // Backlog — live review tasks only (enabled feed, still on it, not past).
  const today = now.toISOString().slice(0, 10);
  const live = items.filter((i) => liveFeedIds.has(i.feedId) && isLiveReview(i, today));
  const ages = live.map((i) => (now.getTime() - i.firstSeenAt.getTime()) / DAY_MS);
  const backlogFormula =
    "items awaiting_review on an enabled feed, still carried (missing_since NULL), event today or later; age = now − first_seen_at";
  const noBacklog = "no item is awaiting review";
  const oldest = ages.length ? round1(Math.max(...ages)) : null;
  const med = median(ages);

  // Lead time — over items first seen in the window, with a dated event not
  // already past when we first saw it (a past event on a feed is history, not lead).
  const leads = items
    .filter((i) => i.firstSeenAt.getTime() >= since.getTime())
    .map((i) => {
      const d = itemDateMs(i.startLocal);
      return d == null ? null : dayOf(d) - dayOf(i.firstSeenAt.getTime());
    })
    .filter((x): x is number => x !== null && x >= 0);
  const leadMed = median(leads);
  const late = leads.filter((x) => x < FEED_LATE_LEAD_DAYS).length;

  // Change capture — feed discrepancies opened in the window.
  const ch = changes.filter((c) => c.detectedAt.getTime() >= since.getTime());
  const cancels = ch.filter((c) => c.kind === "feed_cancelled" || c.kind === "feed_dropped").length;
  const dated = ch.filter((c) => c.eventStart !== null);
  const before = dated.filter(
    (c) => dayOf(c.detectedAt.getTime()) < dayOf(c.eventStart!.getTime())
  ).length;

  return {
    funnel: {
      steps,
      dropped_by_rule: [...byRule.entries()]
        .map(([rule, count]) => ({ rule, count }))
        .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
      matched_outside_filter: matchedOutside,
    },
    backlog: {
      awaiting_review: { value: live.length, formula: backlogFormula },
      oldest_age_days: {
        value: oldest,
        formula: "max age in days of the backlog items",
        ...(oldest == null ? { reason: noBacklog } : {}),
      },
      median_age_days: {
        value: med == null ? null : round1(med),
        formula: "median age in days of the backlog items",
        ...(med == null ? { reason: noBacklog } : {}),
      },
      older_than_target: {
        value: ages.filter((a) => a > targetDays).length,
        formula: `backlog items older than ${targetDays} days`,
      },
      target_days: targetDays,
    },
    lead_time: {
      median_days: {
        value: leadMed,
        formula:
          "median of (event date − first_seen date) in whole days, over items first seen in the window with an event date on or after first sighting",
        ...(leadMed == null ? { reason: "no dated item was first seen in the window" } : {}),
      },
      share_under_14_days: {
        value: rate(late, leads.length),
        formula: `share of those items first seen fewer than ${FEED_LATE_LEAD_DAYS} days before the event`,
        ...(leads.length === 0 ? { reason: "no dated item was first seen in the window" } : {}),
      },
    },
    change_capture: {
      detected: {
        value: ch.length,
        formula: `event_discrepancies with detected_by = '${FEED_DISCREPANCY_DETECTOR}' detected in the window`,
      },
      cancellations: {
        value: cancels,
        formula:
          "of those, kind feed_cancelled (the feed marks it cancelled) or feed_dropped (it left the feed)",
      },
      before_event: {
        value: dated.length ? before : null,
        formula:
          "of those with a dated event, detected on a calendar day before the event's start date",
        ...(dated.length ? {} : { reason: "no feed discrepancy in the window has a dated event" }),
      },
    },
  };
}

/** Pure — the whole report from plain rows. Exported for tests. */
export function buildFeedLaneMetrics(input: FeedLaneInput): FeedLaneMetrics {
  const { now, windowDays } = input;
  const targetDays = input.targetDays ?? FEED_REVIEW_TARGET_DAYS;
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const enabledIds = new Set(input.feeds.filter((f) => f.enabled).map((f) => f.id));
  const healthyFeeds = input.feeds.filter((f) => isFeedHealthy(f, now));
  const healthyPromoters = new Set(healthyFeeds.map((f) => f.promoterId));
  const feedPromoter = new Map(input.feeds.map((f) => [f.id, f.promoterId]));
  const feedName = new Map(input.feeds.map((f) => [f.id, f.promoterName]));

  const total = buildSection(input.items, enabledIds, input.changes, now, since, targetDays);

  const cov = input.coverage;
  const covN = cov.length;
  const withHealthy = cov.filter((c) => c.promoterId && healthyPromoters.has(c.promoterId)).length;
  const feedLinked = cov.filter((c) => c.feedLinked).length;
  const byMethod = new Map<string, number>();
  for (const c of cov) {
    const m = c.ingestionMethod ?? "(unrecorded)";
    byMethod.set(m, (byMethod.get(m) ?? 0) + 1);
  }
  const noUpcoming = "no upcoming public event in scope";
  const newToUs = (days: number) =>
    input.items.filter(
      (i) =>
        i.reviewState === "awaiting_review" &&
        i.eventId === null &&
        i.firstSeenAt.getTime() >= now.getTime() - days * DAY_MS
    ).length;

  return {
    generated_at: now.toISOString(),
    window: {
      days: windowDays,
      since: since.toISOString(),
      rule: "funnel: items carried by a read since `since`; lead time and new-to-us: items first seen since `since`; change capture: discrepancies detected since `since`; backlog and coverage: now",
    },
    feeds: {
      registered: input.feeds.length,
      enabled: enabledIds.size,
      healthy: healthyFeeds.length,
      healthy_rule: `enabled, and last_ok_at within max(${HEALTHY_MIN_HOURS}h, ${HEALTHY_POLL_MULTIPLE} × poll_interval_hours)`,
      open_health_flags: (input.flags ?? [])
        .filter((fl) => enabledIds.has(fl.feedId))
        .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())
        .map((fl) => ({
          feed_id: fl.feedId,
          promoter: feedName.get(fl.feedId) ?? null,
          check: fl.check,
          detail: fl.detail,
          first_seen_at: fl.firstSeenAt.toISOString(),
        })),
    },
    total,
    coverage: {
      upcoming_public_events: covN,
      share_with_healthy_feed: {
        value: rate(withHealthy, covN),
        formula:
          "upcoming public events whose promoter has a healthy feed / upcoming public events",
        ...(covN ? {} : { reason: noUpcoming }),
      },
      share_feed_linked: {
        value: rate(feedLinked, covN),
        formula:
          "upcoming public events a feed item links to (watched by a feed) / upcoming public events",
        ...(covN ? {} : { reason: noUpcoming }),
      },
      by_ingestion_method: [...byMethod.entries()]
        .map(([method, count]) => ({ method, count }))
        .sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
      new_to_us: {
        value: newToUs(windowDays),
        formula:
          "items first seen in the window on a promoter's feed that matched no listing (awaiting_review, no event)",
      },
      new_to_us_7d: { value: newToUs(7), formula: "the same, first seen in the last 7 days" },
    },
    per_feed: input.feeds.map((f) => ({
      feed_id: f.id,
      promoter_id: f.promoterId,
      promoter: f.promoterName,
      url: f.url,
      enabled: f.enabled,
      healthy: isFeedHealthy(f, now),
      ...buildSection(
        input.items.filter((i) => i.feedId === f.id),
        enabledIds,
        input.changes.filter(
          (c) => c.promoterId !== null && c.promoterId === feedPromoter.get(f.id)
        ),
        now,
        since,
        targetDays
      ),
    })),
  };
}

/** "1 health flag open (Gurley Antique Shows: volume_drop)" — OPE-1633. Pure. */
export function feedHealthFlagsText(m: FeedLaneMetrics, maxNamed = 3): string | null {
  const flags = m.feeds.open_health_flags ?? [];
  if (flags.length === 0) return null;
  const named = flags
    .slice(0, maxNamed)
    .map((f) => `${f.promoter ?? f.feed_id}: ${f.check}`)
    .join("; ");
  const more = flags.length > maxNamed ? `; +${flags.length - maxNamed} more` : "";
  return `${flags.length} health flag${flags.length === 1 ? "" : "s"} open (${named}${more})`;
}

/** The digest's one feeds line. Pure. */
export function feedLaneDigestLine(m: FeedLaneMetrics): string {
  const b = m.total.backlog;
  const oldest = b.oldest_age_days.value;
  const oldestTxt = oldest == null ? "" : ` (oldest ${oldest < 1 ? "<1" : Math.floor(oldest)}d)`;
  const flags = feedHealthFlagsText(m);
  return (
    `Feeds: ${m.feeds.healthy} of ${m.feeds.enabled} healthy, ` +
    (flags ? `${flags}, ` : "") +
    `${b.awaiting_review.value ?? 0} awaiting review${oldestTxt}, ` +
    `${m.coverage.new_to_us_7d.value ?? 0} new to us this week (get_feed_lane_metrics, OPE-1632).`
  );
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Fetch the rows and build the report. `publicWhere` is the caller's
 * `publicEventWhere()` — both deploy artifacts own one, kept in sync, and this
 * package does not depend on the constants package.
 *
 * Cost: the feed tables are small (70 items on 2026-11-11). The coverage read
 * is one indexed pass over upcoming public events, projected to three columns;
 * "feed-linked" is an IN over the linked event ids, not a join per row.
 */
export async function loadFeedLaneMetrics(
  db: Db,
  opts: {
    now: Date;
    /** The caller's `publicEventWhere()`; it must not be undefined. */
    publicWhere: SQL | undefined;
    windowDays?: number;
    targetDays?: number;
    promoterId?: string;
  }
): Promise<FeedLaneMetrics> {
  const { now } = opts;
  // A missing gate would make "published" and coverage count every event.
  if (!opts.publicWhere) throw new Error("loadFeedLaneMetrics: publicWhere is required");
  const publicWhere = opts.publicWhere;
  const windowDays = opts.windowDays ?? 30;
  const f = promoterEventFeeds;
  const feeds = await db
    .select({
      id: f.id,
      promoterId: f.promoterId,
      promoterName: promoters.companyName,
      url: f.feedUrl,
      enabled: f.enabled,
      lastOkAt: f.lastOkAt,
      pollIntervalHours: f.pollIntervalHours,
      consecutiveErrors: f.consecutiveErrors,
    })
    .from(f)
    .leftJoin(promoters, eq(promoters.id, f.promoterId))
    .where(opts.promoterId ? eq(f.promoterId, opts.promoterId) : undefined)
    .orderBy(f.createdAt);
  const feedIds = feeds.map((x) => x.id);
  const i = promoterFeedItems;
  const itemRows = feedIds.length
    ? await db
        .select({
          feedId: i.feedId,
          eventId: i.eventId,
          included: i.included,
          exclusionReason: i.exclusionReason,
          reviewState: i.reviewState,
          firstSeenAt: i.firstSeenAt,
          lastSeenAt: i.lastSeenAt,
          startLocal: i.startLocal,
          missingSince: i.missingSince,
          eventPublic: sql<number | null>`CASE WHEN ${i.eventId} IS NULL THEN NULL
            WHEN EXISTS (SELECT 1 FROM ${events} WHERE ${events.id} = ${i.eventId} AND ${publicWhere}) THEN 1 ELSE 0 END`,
        })
        .from(i)
        .innerJoin(f, eq(f.id, i.feedId))
        .where(opts.promoterId ? eq(f.promoterId, opts.promoterId) : undefined)
    : [];
  const items: FeedItemRow[] = itemRows.map((r) => ({
    ...r,
    included: !!r.included,
    eventPublic: r.eventPublic == null ? null : Number(r.eventPublic) === 1,
  }));

  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const d = eventDiscrepancies;
  const changeRows = await db
    .select({
      eventId: d.eventId,
      promoterId: events.promoterId,
      notes: d.notes,
      detectedAt: d.detectedAt,
      eventStart: events.startDate,
    })
    .from(d)
    .innerJoin(events, eq(events.id, d.eventId))
    .where(
      and(
        eq(d.detectedBy, FEED_DISCREPANCY_DETECTOR),
        gte(d.detectedAt, since),
        opts.promoterId ? eq(events.promoterId, opts.promoterId) : undefined
      )
    );
  const changes: FeedChangeRow[] = changeRows.map((c) => {
    let kind: string | null = null;
    try {
      const n = c.notes ? (JSON.parse(c.notes) as { kind?: unknown }) : null;
      kind = typeof n?.kind === "string" ? n.kind : null;
    } catch {
      kind = null;
    }
    return {
      eventId: c.eventId,
      promoterId: c.promoterId,
      kind,
      detectedAt: c.detectedAt,
      eventStart: c.eventStart,
    };
  });

  const covRows = await db
    .select({
      id: events.id,
      promoterId: events.promoterId,
      ingestionMethod: events.ingestionMethod,
    })
    .from(events)
    .where(
      and(
        publicWhere,
        upcomingEndPredicate(now),
        opts.promoterId ? eq(events.promoterId, opts.promoterId) : undefined
      )
    );
  const linkedIds = new Set(items.map((x) => x.eventId).filter((x): x is string => !!x));
  const coverage: CoverageRow[] = covRows.map((c) => ({
    promoterId: c.promoterId,
    ingestionMethod: c.ingestionMethod ?? null,
    feedLinked: linkedIds.has(c.id),
  }));

  // OPE-1633 — open health flags for the feeds in scope (tiny table).
  const flagRows = feedIds.length
    ? await db
        .select({
          feedId: feedHealthFlags.feedId,
          check: feedHealthFlags.checkName,
          detail: feedHealthFlags.detail,
          firstSeenAt: feedHealthFlags.firstSeenAt,
        })
        .from(feedHealthFlags)
        .innerJoin(f, eq(f.id, feedHealthFlags.feedId))
        .where(
          and(
            isNull(feedHealthFlags.clearedAt),
            opts.promoterId ? eq(f.promoterId, opts.promoterId) : undefined
          )
        )
    : [];

  return buildFeedLaneMetrics({
    now,
    windowDays,
    flags: flagRows,
    targetDays: opts.targetDays,
    feeds: feeds.map((x) => ({ ...x, enabled: !!x.enabled })),
    items,
    changes,
    coverage,
  });
}
