/**
 * OPE-1635 — feed analytics 4/5: safe rule changes. The D1 half.
 *
 *   recordFeedItemSnapshot — the ingest's one call: keep each DISTINCT version
 *                            of an item (by content hash), newest
 *                            FEED_ITEM_SNAPSHOT_KEEP per item.
 *   loadReplayCorpus       — every feed item (latest snapshot, plus history
 *                            versions on request) with its labels, ready for
 *                            the pure `backtestInclusion` / `backtestMatcher`.
 *   runFeedBacktest        — what `backtest_feed_rules` returns. Read-only.
 *   recordFeedRuleChange / fillDueRuleChangeFollowups / listFeedRuleChanges
 *                          — the change log, its 7-day-after metrics, and the
 *                            read the metrics tool exposes.
 *
 * Labels: explicit `feed_item_labels` rows (OPE-1634, from 2026-11-26) PLUS the
 * review decisions made before they existed, read from the item itself —
 * `review_state = 'rejected'` is a reject, `link_basis = 'review_approve'` an
 * approve, `review_link` a missed match. OPE-1634 did not backfill these as
 * LABEL ROWS because the rule in force at the time was never stored, and a
 * label row carries its rule. A backtest needs only the verdict, not the rule,
 * so here they count, marked `implied` so a reader can tell them apart.
 */
import { and, desc, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";
import {
  events,
  feedItemLabels,
  feedRuleChanges,
  promoterEventFeeds,
  promoterFeedItemSnapshots,
  promoterFeedItems,
  promoters,
} from "./index";
import {
  backtestInclusion,
  backtestMatcher,
  campsWorkshopsOptInActive,
  DEFAULT_MATCHER_SETTINGS,
  parseInclusionRules,
  PRE_OPE1629_INCLUSION_RULES,
  type CorpusItem,
  type CorpusLabel,
  type FeedEvent,
  type FeedInclusionRules,
  type FeedMatcherSettings,
  type InclusionBacktest,
  type MatcherBacktest,
  type MatcherCorpusItem,
} from "@takemetothefair/utils/feeds";
import { loadFeedQuality } from "./feed-quality";

type Db = DrizzleD1Database<typeof schema>;

const DAY_MS = 86_400_000;
/** Distinct versions kept per item. Items change rarely; 10 covers months of edits. */
export const FEED_ITEM_SNAPSHOT_KEEP = 10;
/** The change log's "after" snapshot is taken this long after the change. */
export const RULE_CHANGE_FOLLOWUP_DAYS = 7;
/** Flip lists in a tool response are capped; counts are always whole. */
export const BACKTEST_LIST_CAP = 50;

// ── history ────────────────────────────────────────────────────────────────

/**
 * Keep this version of the item if it is new. Idempotent on (item, hash): a
 * re-read of an unchanged item writes nothing. Prunes the item's history to
 * the newest FEED_ITEM_SNAPSHOT_KEEP only when it inserted.
 */
export async function recordFeedItemSnapshot(
  db: Db,
  v: { feedItemId: string; feedId: string; contentHash: string; snapshot: string; now: Date }
): Promise<boolean> {
  const inserted = await db
    .insert(promoterFeedItemSnapshots)
    .values({
      // id: the schema's $defaultFn (no crypto.randomUUID here: this module is
      // client-reachable via the metrics types, under the browser floor guard).
      feedItemId: v.feedItemId,
      feedId: v.feedId,
      contentHash: v.contentHash,
      snapshot: v.snapshot,
      capturedAt: v.now,
    })
    .onConflictDoNothing()
    .returning({ id: promoterFeedItemSnapshots.id });
  if (!inserted.length) return false;
  const keep = await db
    .select({ id: promoterFeedItemSnapshots.id })
    .from(promoterFeedItemSnapshots)
    .where(eq(promoterFeedItemSnapshots.feedItemId, v.feedItemId))
    .orderBy(desc(promoterFeedItemSnapshots.capturedAt), desc(promoterFeedItemSnapshots.id))
    .limit(FEED_ITEM_SNAPSHOT_KEEP);
  if (keep.length === FEED_ITEM_SNAPSHOT_KEEP) {
    await db.delete(promoterFeedItemSnapshots).where(
      and(
        eq(promoterFeedItemSnapshots.feedItemId, v.feedItemId),
        notInArray(
          promoterFeedItemSnapshots.id,
          keep.map((k) => k.id)
        )
      )
    );
  }
  return true;
}

// ── corpus ─────────────────────────────────────────────────────────────────

export interface ReplayCorpus {
  feeds: Array<{
    feedId: string;
    promoterId: string;
    storedRules: FeedInclusionRules;
    /** The feed's stored rules failed to parse — it replays on the defaults, and says so. */
    storedRulesError: string | null;
  }>;
  inclusion: CorpusItem[];
  matcher: MatcherCorpusItem[];
  labels: { explicit: number; implied: number };
  /** Items with no usable snapshot (never read since 0406, or unparsable). */
  skipped: number;
}

const toMs = (d: Date | null | undefined) => (d ? d.getTime() : 0);

/** The review decision an item carries in its own row (pre-OPE-1634 ground truth). */
export function impliedLabel(item: {
  reviewState: string;
  linkBasis: string | null;
}): string | null {
  if (item.reviewState === "rejected") return "rejected";
  if (item.linkBasis === "review_approve") return "approved";
  if (item.linkBasis === "review_link") return "missed_match";
  return null;
}

export async function loadReplayCorpus(
  db: Db,
  opts: { feedIds?: string[]; includeHistory?: boolean } = {}
): Promise<ReplayCorpus> {
  const feedRows = await db
    .select({
      id: promoterEventFeeds.id,
      promoterId: promoterEventFeeds.promoterId,
      inclusionRules: promoterEventFeeds.inclusionRules,
      includeCampsWorkshops: promoters.includeCampsWorkshops,
      claimed: promoters.claimed,
      userId: promoters.userId,
    })
    .from(promoterEventFeeds)
    .leftJoin(promoters, eq(promoters.id, promoterEventFeeds.promoterId))
    .where(opts.feedIds?.length ? inArray(promoterEventFeeds.id, opts.feedIds) : undefined);

  const feeds: ReplayCorpus["feeds"] = feedRows.map((f) => {
    try {
      return {
        feedId: f.id,
        promoterId: f.promoterId,
        storedRules: parseInclusionRules(f.inclusionRules),
        storedRulesError: null,
      };
    } catch (e) {
      return {
        feedId: f.id,
        promoterId: f.promoterId,
        storedRules: parseInclusionRules(null),
        storedRulesError: (e as Error).message,
      };
    }
  });
  const optIn = new Map(
    feedRows.map((f) => [
      f.id,
      campsWorkshopsOptInActive({
        includeCampsWorkshops: f.includeCampsWorkshops ?? null,
        claimed: f.claimed ?? null,
        userId: f.userId ?? null,
      }),
    ])
  );
  const out: ReplayCorpus = {
    feeds,
    inclusion: [],
    matcher: [],
    labels: { explicit: 0, implied: 0 },
    skipped: 0,
  };
  if (!feeds.length) return out;

  const feedIds = feeds.map((f) => f.feedId);
  const promoterOf = new Map(feeds.map((f) => [f.feedId, f.promoterId]));
  // Bounded bind lists (D1's 100-parameter cap): feeds are few, items are not.
  type ItemRow = {
    id: string;
    feedId: string;
    snapshot: string | null;
    eventId: string | null;
    linkBasis: string | null;
    unlinkedEventId: string | null;
    reviewState: string;
    reviewedAt: Date | null;
    lastSeenAt: Date;
  };
  const items: ItemRow[] = [];
  for (let k = 0; k < feedIds.length; k += 50) {
    items.push(
      ...(await db
        .select({
          id: promoterFeedItems.id,
          feedId: promoterFeedItems.feedId,
          snapshot: promoterFeedItems.snapshot,
          eventId: promoterFeedItems.eventId,
          linkBasis: promoterFeedItems.linkBasis,
          unlinkedEventId: promoterFeedItems.unlinkedEventId,
          reviewState: promoterFeedItems.reviewState,
          reviewedAt: promoterFeedItems.reviewedAt,
          lastSeenAt: promoterFeedItems.lastSeenAt,
        })
        .from(promoterFeedItems)
        .where(inArray(promoterFeedItems.feedId, feedIds.slice(k, k + 50))))
    );
  }

  const labelsByItem = new Map<string, CorpusLabel[]>();
  for (let k = 0; k < feedIds.length; k += 50) {
    const rows = await db
      .select({
        feedItemId: feedItemLabels.feedItemId,
        label: feedItemLabels.label,
        createdAt: feedItemLabels.createdAt,
      })
      .from(feedItemLabels)
      .where(inArray(feedItemLabels.feedId, feedIds.slice(k, k + 50)));
    for (const r of rows) {
      const list = labelsByItem.get(r.feedItemId) ?? [];
      list.push({ label: r.label, at: toMs(r.createdAt) });
      labelsByItem.set(r.feedItemId, list);
      out.labels.explicit++;
    }
  }
  for (const it of items) {
    const implied = impliedLabel(it);
    if (!implied) continue;
    // Dated at the review (or, failing that, epoch 1): an explicit label made
    // after it — a reviewer changing their mind — wins in labelExpectation.
    const list = labelsByItem.get(it.id) ?? [];
    list.push({ label: implied, at: toMs(it.reviewedAt) || 1 });
    labelsByItem.set(it.id, list);
    out.labels.implied++;
  }

  const history = new Map<string, Array<{ snapshot: string; capturedAt: Date }>>();
  if (opts.includeHistory) {
    for (let k = 0; k < feedIds.length; k += 50) {
      const rows = await db
        .select({
          feedItemId: promoterFeedItemSnapshots.feedItemId,
          snapshot: promoterFeedItemSnapshots.snapshot,
          capturedAt: promoterFeedItemSnapshots.capturedAt,
        })
        .from(promoterFeedItemSnapshots)
        .where(inArray(promoterFeedItemSnapshots.feedId, feedIds.slice(k, k + 50)));
      for (const r of rows) {
        const list = history.get(r.feedItemId) ?? [];
        list.push(r);
        history.set(r.feedItemId, list);
      }
    }
  }

  // Matcher candidates: each promoter's listings (the date + name match's set).
  const promoterIds = [...new Set(feeds.map((f) => f.promoterId))];
  const candidatesByPromoter = new Map<
    string,
    Array<{ id: string; name: string; startDate: string | null }>
  >();
  for (let k = 0; k < promoterIds.length; k += 50) {
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        startDate: events.startDate,
        promoterId: events.promoterId,
      })
      .from(events)
      .where(inArray(events.promoterId, promoterIds.slice(k, k + 50)));
    for (const r of rows) {
      const list = candidatesByPromoter.get(r.promoterId) ?? [];
      list.push({
        id: r.id,
        name: r.name,
        startDate: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
      });
      candidatesByPromoter.set(r.promoterId, list);
    }
  }

  const parse = (s: string | null): FeedEvent | null => {
    if (!s) return null;
    try {
      const ev = JSON.parse(s) as FeedEvent;
      return ev && typeof ev.title === "string" ? ev : null;
    } catch {
      return null;
    }
  };

  for (const it of items) {
    const latest = parse(it.snapshot);
    if (!latest) {
      out.skipped++;
      continue;
    }
    const labels = labelsByItem.get(it.id) ?? [];
    const base = {
      itemId: it.id,
      feedId: it.feedId,
      campsWorkshopsOptIn: optIn.get(it.feedId) ?? false,
      labels,
    };
    out.inclusion.push({ ...base, version: "latest", event: latest });
    for (const h of history.get(it.id) ?? []) {
      const ev = parse(h.snapshot);
      // The latest version is already in the corpus; history adds only the OTHER versions.
      if (!ev || h.snapshot === it.snapshot) continue;
      out.inclusion.push({ ...base, version: h.capturedAt.toISOString(), event: ev });
    }
    out.matcher.push({
      itemId: it.id,
      feedId: it.feedId,
      title: latest.title,
      startDate: latest.startDate,
      eventId: it.eventId,
      linkBasis: it.linkBasis,
      unlinkedEventId: it.unlinkedEventId,
      labels,
      candidates: candidatesByPromoter.get(promoterOf.get(it.feedId) ?? "") ?? [],
    });
  }
  return out;
}

// ── the tool ───────────────────────────────────────────────────────────────

export const BACKTEST_BASELINE_PRESETS = {
  /** Each feed's stored rules (the defaults where a feed stores none). */
  current: null,
  /** The defaults as they stood before OPE-1629 (#1780) — replays that fix. */
  pre_ope1629: PRE_OPE1629_INCLUSION_RULES,
} as const;
export type BacktestBaselinePreset = keyof typeof BACKTEST_BASELINE_PRESETS;

export interface FeedBacktestArgs {
  feedIds?: string[];
  /** Partial rules laid over each feed's stored rules for the "after" side. */
  proposedRules?: Partial<FeedInclusionRules>;
  /** Partial rules laid over each feed's stored rules for the "before" side. */
  baselineRules?: Partial<FeedInclusionRules>;
  baselinePreset?: BacktestBaselinePreset;
  proposedMatcher?: Partial<FeedMatcherSettings>;
  includeHistory?: boolean;
}

export interface FeedBacktestResult {
  corpus: {
    feeds: number;
    items: number;
    versions: number;
    labelled: number;
    labels: { explicit: number; implied: number };
    skipped_without_snapshot: number;
    feeds_with_unparsable_rules: Array<{ feed_id: string; error: string }>;
  };
  inclusion: Omit<InclusionBacktest, "to_dropped" | "to_included" | "wrong_way"> & {
    to_dropped: { count: number; items: InclusionBacktest["to_dropped"] };
    to_included: { count: number; items: InclusionBacktest["to_included"] };
    wrong_way: { count: number; items: InclusionBacktest["wrong_way"] };
  };
  matcher: Omit<MatcherBacktest, "gained" | "lost" | "changed"> & {
    baseline: FeedMatcherSettings;
    proposed: FeedMatcherSettings;
    gained: { count: number; items: MatcherBacktest["gained"] };
    lost: { count: number; items: MatcherBacktest["lost"] };
    changed: { count: number; items: MatcherBacktest["changed"] };
  };
  /** Paste into the PR body — the CI gate looks for a `## Backtest` section. */
  summary_markdown: string;
}

const capped = <T>(xs: T[]) => ({ count: xs.length, items: xs.slice(0, BACKTEST_LIST_CAP) });

const pct = (v: number | null) => (v == null ? "n/a" : `${Math.round(v * 1000) / 10}%`);

export async function runFeedBacktest(
  db: Db,
  args: FeedBacktestArgs = {}
): Promise<FeedBacktestResult> {
  const corpus = await loadReplayCorpus(db, {
    feedIds: args.feedIds,
    includeHistory: args.includeHistory ?? false,
  });
  const stored = new Map(corpus.feeds.map((f) => [f.feedId, f.storedRules]));
  const preset = args.baselinePreset ? BACKTEST_BASELINE_PRESETS[args.baselinePreset] : null;
  const base = (feedId: string) => stored.get(feedId) ?? parseInclusionRules(null);
  const inc = backtestInclusion(
    corpus.inclusion,
    { rulesFor: (i) => ({ ...base(i.feedId), ...(preset ?? {}), ...(args.baselineRules ?? {}) }) },
    { rulesFor: (i) => ({ ...base(i.feedId), ...(args.proposedRules ?? {}) }) }
  );
  const proposedMatcher = { ...DEFAULT_MATCHER_SETTINGS, ...(args.proposedMatcher ?? {}) };
  const m = backtestMatcher(corpus.matcher, DEFAULT_MATCHER_SETTINGS, proposedMatcher);

  const lines = [
    "## Backtest",
    "",
    `Corpus: ${inc.examined.items} items (${inc.examined.versions} versions) across ${corpus.feeds.length} feeds, ${inc.examined.labelled} labelled (${corpus.labels.explicit} explicit, ${corpus.labels.implied} implied from reviews).`,
    `Inclusion: ${inc.to_included.length} dropped → included, ${inc.to_dropped.length} included → dropped, **${inc.wrong_way.length} wrong-way** (against a label).`,
    `Precision ${pct(inc.before.precision.value)} → ${pct(inc.after.precision.value)}; false-drop rate ${pct(inc.before.false_drop_rate.value)} → ${pct(inc.after.false_drop_rate.value)}.`,
    `Matcher (min name key ${DEFAULT_MATCHER_SETTINGS.minNameKeyLength} → ${proposedMatcher.minNameKeyLength}): ${m.gained.length} gained, ${m.lost.length} lost, ${m.changed.length} changed.`,
  ];
  for (const f of inc.wrong_way.slice(0, 10)) {
    lines.push(
      `- WRONG-WAY: "${f.title}" (${f.start_date ?? "no date"}) expected ${f.expected}, now ${f.after.included ? "included" : "dropped"} by ${f.after.rule}`
    );
  }
  return {
    corpus: {
      feeds: corpus.feeds.length,
      items: inc.examined.items,
      versions: inc.examined.versions,
      labelled: inc.examined.labelled,
      labels: corpus.labels,
      skipped_without_snapshot: corpus.skipped,
      feeds_with_unparsable_rules: corpus.feeds
        .filter((f) => f.storedRulesError)
        .map((f) => ({ feed_id: f.feedId, error: f.storedRulesError! })),
    },
    inclusion: {
      examined: inc.examined,
      unchanged: inc.unchanged,
      before: inc.before,
      after: inc.after,
      to_dropped: capped(inc.to_dropped),
      to_included: capped(inc.to_included),
      wrong_way: capped(inc.wrong_way),
    },
    matcher: {
      examined: m.examined,
      confirmed_by_labels: m.confirmed_by_labels,
      baseline: DEFAULT_MATCHER_SETTINGS,
      proposed: proposedMatcher,
      gained: capped(m.gained),
      lost: capped(m.lost),
      changed: capped(m.changed),
    },
    summary_markdown: lines.join("\n"),
  };
}

// ── change log ─────────────────────────────────────────────────────────────

const allFeedIds = async (db: Db) =>
  (await db.select({ id: promoterEventFeeds.id }).from(promoterEventFeeds)).map((r) => r.id);

export async function recordFeedRuleChange(
  db: Db,
  v: {
    kind: "inclusion" | "matcher" | "both";
    pr: string | null;
    opeId: string | null;
    summary: string;
    backtest: string | null;
    changedAt: Date;
    now: Date;
  }
): Promise<{ id: string; after_due_at: string }> {
  const quality = await loadFeedQuality(db, await allFeedIds(db));
  const afterDueAt = new Date(v.changedAt.getTime() + RULE_CHANGE_FOLLOWUP_DAYS * DAY_MS);
  const [{ id }] = await db
    .insert(feedRuleChanges)
    .values({
      changedAt: v.changedAt,
      kind: v.kind,
      pr: v.pr,
      opeId: v.opeId,
      summary: v.summary,
      backtest: v.backtest,
      metricsBefore: JSON.stringify(quality),
      metricsBeforeNote: null,
      afterDueAt,
      createdAt: v.now,
    })
    .returning({ id: feedRuleChanges.id });
  return { id, after_due_at: afterDueAt.toISOString() };
}

/**
 * The hourly cron's step: every change whose 7 days have passed and has no
 * "after" snapshot gets one now. Idempotent (only rows with metrics_after
 * NULL). Returns how many it filled.
 */
export async function fillDueRuleChangeFollowups(db: Db, now: Date): Promise<number> {
  const due = await db
    .select({ id: feedRuleChanges.id })
    .from(feedRuleChanges)
    .where(and(isNull(feedRuleChanges.metricsAfter), lte(feedRuleChanges.afterDueAt, now)));
  if (!due.length) return 0;
  const quality = JSON.stringify(await loadFeedQuality(db, await allFeedIds(db)));
  for (const d of due) {
    await db
      .update(feedRuleChanges)
      .set({ metricsAfter: quality, metricsAfterAt: now })
      .where(and(eq(feedRuleChanges.id, d.id), isNull(feedRuleChanges.metricsAfter)));
  }
  return due.length;
}

export async function listFeedRuleChanges(db: Db, limit = 10) {
  const rows = await db
    .select()
    .from(feedRuleChanges)
    .orderBy(desc(feedRuleChanges.changedAt))
    .limit(limit);
  const parse = (s: string | null) => (s ? JSON.parse(s) : null);
  return rows.map((r) => ({
    id: r.id,
    changed_at: r.changedAt.toISOString(),
    kind: r.kind,
    pr: r.pr,
    ope_id: r.opeId,
    summary: r.summary,
    backtest: r.backtest,
    metrics_before: parse(r.metricsBefore),
    metrics_before_note: r.metricsBeforeNote,
    after_due_at: r.afterDueAt.toISOString(),
    metrics_after: parse(r.metricsAfter),
    metrics_after_at: r.metricsAfterAt?.toISOString() ?? null,
  }));
}

/**
 * Probe helper: when the oldest change still owed its "after" snapshot BECAME
 * owed, or null. That is max(after_due_at, created_at): a row backfilled after
 * its due date (OPE-1629's) cannot have been filled before it existed, so its
 * clock starts at insertion, not at a due date already in the past.
 */
export async function oldestOwedRuleChangeFollowup(db: Db, now: Date): Promise<Date | null> {
  const [r] = await db
    .select({
      t: sql<number | null>`min(max(${feedRuleChanges.afterDueAt}, ${feedRuleChanges.createdAt}))`,
    })
    .from(feedRuleChanges)
    .where(and(isNull(feedRuleChanges.metricsAfter), lte(feedRuleChanges.afterDueAt, now)));
  return r?.t != null ? new Date(Number(r.t) * 1000) : null;
}
