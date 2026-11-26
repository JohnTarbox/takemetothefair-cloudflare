/**
 * OPE-1634 — feed analytics 3/5: quality checks on our own rules.
 *
 * Our inclusion rules decide which feed items reach review, and our matcher
 * decides which get linked. Both can be wrong silently (Marshfield's 7 markets
 * dropped as a kids' program, OPE-1629; Jenks's two missed matches on
 * 2026-11-11). Every reviewer decision is free ground truth, so this module
 * turns decisions into LABELS and labels into precision numbers:
 *
 *   recordFeedItemLabel   — the one writer of `feed_item_labels`, called by the
 *                           main app's review step and the MCP
 *                           `label_dropped_feed_item` tool.
 *   selectDropSample      — pure: the weekly stratified sample of DROPPED items.
 *   ensureWeeklyDropSample — writes this week's `feed_drop_samples` row (even
 *                           when empty) from the MCP hourly cron. Idempotent.
 *   renderDropSampleIssue — the Linear ticket an agent files for the analyst
 *                           (the Worker has no Linear token — OPE-76's rail).
 *   buildFeedQuality      — pure: per-rule precision, false-drop rate, matcher
 *                           accuracy and feed-vs-us accuracy.
 *
 * Label semantics (a positive is "the filter was right to let this through"):
 *   approved     — included item approved           → positive for its rule
 *   missed_match — included item linked by hand     → positive for its rule, AND
 *                  a miss for the matcher (it was already one of our listings)
 *   rejected     — included item rejected           → negative for its rule
 *   wrong_match  — an unlinked item                 → a matcher error; counted
 *                  against AUTOMATIC links only when its link_basis was one
 *   correct_drop / false_drop — the analyst's verdict on a sampled drop.
 * A label on an item the filter did NOT include (a reviewer acting on a dropped
 * item) is kept, but does not count toward that rule's precision — the rule
 * dropped it, it never "let it through".
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";
import {
  feedDropSamples,
  feedItemLabels,
  promoterEventFeeds,
  promoterFeedItems,
  promoters,
  type FeedItemLabel,
} from "./index";
import { inclusionRuleKey, matchedSnippet } from "@takemetothefair/utils/feeds";

type Db = DrizzleD1Database<typeof schema>;

const DAY_MS = 86_400_000;

/** Link bases the INGEST sets — an automatic match (mcp-server feeds/ingest.ts linkItem). */
export const AUTOMATIC_LINK_BASES = [
  "source_url",
  "promoter_date_name",
  // drizzle/0438: an ingest link made before link_basis existed (no reviewer
  // touched it). Its exact basis was never stored, so it is not guessed.
  "auto_pre_ope1634",
] as const;
export const isAutomaticLinkBasis = (b: string | null | undefined) =>
  !!b && (AUTOMATIC_LINK_BASES as readonly string[]).includes(b);

/** The sample's cap (the ticket: "up to 20 items"). */
export const DROP_SAMPLE_MAX = 20;
/** A feed dropping more than this share of what it carried is always sampled. */
export const DROP_SAMPLE_FEED_SHARE = 0.5;
/** The analyst lane the sample ticket routes to (John 2026-11-11). */
export const DROP_SAMPLE_AGENT = "analyst-claude-desktop" as const;

// ── Labels ───────────────────────────────────────────────────────────────────

export interface FeedItemLabelInput {
  feedItemId: string;
  feedId: string;
  label: FeedItemLabel;
  /** The verdict's reason at labelling time (rule key is derived from it). */
  reason: string | null;
  included: boolean | null;
  linkBasis?: string | null;
  eventId?: string | null;
  source: "review" | "analyst";
  actor?: string | null;
  note?: string | null;
  sampleId?: string | null;
  at: Date;
}

/** The insert values; `id` comes from the table's own default (no browser-floor API here). */
export function feedItemLabelRow(input: FeedItemLabelInput) {
  return {
    feedItemId: input.feedItemId,
    feedId: input.feedId,
    label: input.label,
    ruleKey: inclusionRuleKey(input.reason),
    reason: input.reason,
    included: input.included,
    linkBasis: input.linkBasis ?? null,
    eventId: input.eventId ?? null,
    source: input.source,
    actor: input.actor ?? null,
    note: input.note ?? null,
    sampleId: input.sampleId ?? null,
    createdAt: input.at,
  };
}

/** The one writer of `feed_item_labels`. */
export async function recordFeedItemLabel(db: Db, input: FeedItemLabelInput): Promise<string> {
  const [row] = await db
    .insert(feedItemLabels)
    .values(feedItemLabelRow(input))
    .returning({ id: feedItemLabels.id });
  return row.id;
}

/** The reason in force for an item: the stored inclusion reason, else the exclusion reason. */
export const itemReason = (item: {
  inclusionReason?: string | null;
  exclusionReason?: string | null;
}) => item.inclusionReason ?? item.exclusionReason ?? null;

// ── Weekly dropped-item sample ───────────────────────────────────────────────

export interface DropCandidate {
  itemId: string;
  feedId: string;
  promoter: string | null;
  title: string | null;
  startLocal: string | null;
  url: string | null;
  reason: string | null;
  ruleKey: string;
  snippet: string | null;
}

export interface FeedDropShare {
  feedId: string;
  /** Items the feed carried in the window. */
  total: number;
  dropped: number;
}

export interface DropSampleItem extends DropCandidate {
  /** Why it is in the sample: its rule's stratum, a high-drop feed, or the proportional fill. */
  picked_for: "rule" | "feed_over_half_dropped" | "fill";
}

/** FNV-1a: a stable pseudo-random order, so a week's sample is reproducible. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Pure. Stratified by rule: one item from EVERY rule that dropped anything,
 * then one from every feed that dropped more than half of what it carried (if
 * not already represented), then fill to `max` in proportion to each rule's
 * drop count. The mandatory picks are never cut, so a week with more than
 * `max` distinct rules returns more than `max` items — "include every rule"
 * outranks the cap. Order within a stratum is a hash of (seed, item id).
 */
export function selectDropSample(
  candidates: DropCandidate[],
  shares: FeedDropShare[],
  opts: { max?: number; seed: string }
): DropSampleItem[] {
  const max = opts.max ?? DROP_SAMPLE_MAX;
  const order = (c: DropCandidate) => hash(`${opts.seed}:${c.itemId}`);
  const sorted = [...candidates].sort(
    (a, b) => order(a) - order(b) || a.itemId.localeCompare(b.itemId)
  );
  const byRule = new Map<string, DropCandidate[]>();
  for (const c of sorted) byRule.set(c.ruleKey, [...(byRule.get(c.ruleKey) ?? []), c]);
  const picked = new Map<string, DropSampleItem>();
  const take = (c: DropCandidate, why: DropSampleItem["picked_for"]) => {
    if (!picked.has(c.itemId)) picked.set(c.itemId, { ...c, picked_for: why });
  };

  const rules = [...byRule.keys()].sort(
    (a, b) => byRule.get(b)!.length - byRule.get(a)!.length || a.localeCompare(b)
  );
  for (const r of rules) take(byRule.get(r)![0], "rule");

  const heavy = shares
    .filter((s) => s.total > 0 && s.dropped / s.total > DROP_SAMPLE_FEED_SHARE)
    .map((s) => s.feedId)
    .sort();
  for (const feedId of heavy) {
    if ([...picked.values()].some((p) => p.feedId === feedId)) continue;
    const first = sorted.find((c) => c.feedId === feedId);
    if (first) take(first, "feed_over_half_dropped");
  }

  // Proportional fill: each rule's target share of `max`, largest deficit first.
  const total = candidates.length;
  while (picked.size < Math.min(max, total)) {
    let best: string | null = null;
    let bestDeficit = -Infinity;
    for (const r of rules) {
      const pool = byRule.get(r)!;
      const have = [...picked.values()].filter((p) => p.ruleKey === r).length;
      if (have >= pool.length) continue;
      const deficit = (pool.length / total) * max - have;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = r;
      }
    }
    if (!best) break;
    const next = byRule.get(best)!.find((c) => !picked.has(c.itemId));
    if (!next) break;
    take(next, "fill");
  }
  return [...picked.values()].sort(
    (a, b) =>
      a.ruleKey.localeCompare(b.ruleKey) ||
      (a.startLocal ?? "").localeCompare(b.startLocal ?? "") ||
      a.itemId.localeCompare(b.itemId)
  );
}

/** Monday 00:00Z of the week containing `now`, as YYYY-MM-DD. */
export function weekStartOf(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The dropped items a window carried, plus each feed's dropped share. */
export async function loadDropCandidates(
  db: Db,
  window: { start: Date; end: Date }
): Promise<{ candidates: DropCandidate[]; shares: FeedDropShare[] }> {
  const i = promoterFeedItems;
  // "Carried in the window": seen at or after its start, first seen before its
  // end. last_seen_at keeps advancing on later reads, so no upper bound on it.
  const rows = await db
    .select({
      id: i.id,
      feedId: i.feedId,
      promoter: promoters.companyName,
      title: i.title,
      startLocal: i.startLocal,
      url: i.url,
      reviewState: i.reviewState,
      exclusionReason: i.exclusionReason,
      inclusionReason: i.inclusionReason,
      snapshot: i.snapshot,
    })
    .from(i)
    .innerJoin(promoterEventFeeds, eq(promoterEventFeeds.id, i.feedId))
    .leftJoin(promoters, eq(promoters.id, promoterEventFeeds.promoterId))
    .where(and(gte(i.lastSeenAt, window.start), lt(i.firstSeenAt, window.end)));
  const shares = new Map<string, FeedDropShare>();
  const candidates: DropCandidate[] = [];
  for (const r of rows) {
    const s = shares.get(r.feedId) ?? { feedId: r.feedId, total: 0, dropped: 0 };
    s.total++;
    if (r.reviewState === "dropped") {
      s.dropped++;
      const reason = r.exclusionReason ?? r.inclusionReason ?? null;
      let snapshot: { title?: string; description?: string; organizerEmails?: string[] } = {};
      try {
        snapshot = r.snapshot ? JSON.parse(r.snapshot) : {};
      } catch {
        snapshot = {};
      }
      candidates.push({
        itemId: r.id,
        feedId: r.feedId,
        promoter: r.promoter ?? null,
        title: r.title,
        startLocal: r.startLocal,
        url: r.url,
        reason,
        ruleKey: inclusionRuleKey(reason) ?? "unknown",
        snippet: matchedSnippet(
          {
            title: snapshot.title ?? r.title ?? "",
            description: snapshot.description ?? "",
            organizerEmails: snapshot.organizerEmails ?? [],
          },
          reason
        ),
      });
    }
    shares.set(r.feedId, s);
  }
  return { candidates, shares: [...shares.values()] };
}

export type EnsureDropSampleResult =
  | { outcome: "exists"; sample_id: string; week_start: string }
  | {
      outcome: "created";
      sample_id: string;
      week_start: string;
      items: number;
      dropped_total: number;
    };

/**
 * Write this week's sample row if it does not exist yet. The window is the 7
 * days BEFORE this week's Monday. Runs from the hourly cron; any hour of the
 * week catches up a missed Monday. An empty week still writes a row
 * (item_count 0) so the builder's liveness is visible to its probe.
 */
export async function ensureWeeklyDropSample(db: Db, now: Date): Promise<EnsureDropSampleResult> {
  const weekStart = weekStartOf(now);
  const [have] = await db
    .select({ id: feedDropSamples.id })
    .from(feedDropSamples)
    .where(eq(feedDropSamples.weekStart, weekStart))
    .limit(1);
  if (have) return { outcome: "exists", sample_id: have.id, week_start: weekStart };
  const end = new Date(`${weekStart}T00:00:00Z`);
  const start = new Date(end.getTime() - 7 * DAY_MS);
  const { candidates, shares } = await loadDropCandidates(db, { start, end });
  const items = selectDropSample(candidates, shares, { seed: weekStart });
  const inserted = await db
    .insert(feedDropSamples)
    .values({
      weekStart,
      windowStart: start,
      windowEnd: end,
      items: JSON.stringify(items),
      itemCount: items.length,
      droppedTotal: candidates.length,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: feedDropSamples.id });
  if (!inserted.length) {
    // A concurrent writer won the unique(week_start) race: report its row.
    const [row] = await db
      .select({ id: feedDropSamples.id })
      .from(feedDropSamples)
      .where(eq(feedDropSamples.weekStart, weekStart))
      .limit(1);
    return { outcome: "exists", sample_id: row?.id ?? "", week_start: weekStart };
  }
  return {
    outcome: "created",
    sample_id: inserted[0].id,
    week_start: weekStart,
    items: items.length,
    dropped_total: candidates.length,
  };
}

/** Samples with items that no ticket has been filed for, oldest first. */
export async function listUnfiledDropSamples(db: Db) {
  return db
    .select()
    .from(feedDropSamples)
    .where(and(isNull(feedDropSamples.opeId), sql`${feedDropSamples.itemCount} > 0`))
    .orderBy(feedDropSamples.weekStart);
}

export async function recentDropSamples(db: Db, limit = 8) {
  return db.select().from(feedDropSamples).orderBy(desc(feedDropSamples.weekStart)).limit(limit);
}

const cell = (s: string | null | undefined) =>
  (s ?? "—").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";

/**
 * The Linear ticket for one sample: routing bracket, the items, and how to label
 * them. The analyst labels through `label_dropped_feed_item`; only "should have
 * been kept" items or a rule that looks wrong go to John. Nothing is emailed.
 */
export function renderDropSampleIssue(sample: {
  id: string;
  weekStart: string;
  windowStart: Date;
  windowEnd: Date;
  items: string;
  droppedTotal: number;
}): { title: string; body: string } {
  const items = JSON.parse(sample.items) as DropSampleItem[];
  const title = `[agent instructions][${DROP_SAMPLE_AGENT}][task] Feed drop sample, week of ${sample.weekStart}`;
  const rows = items.map(
    (it, n) =>
      `| ${n + 1} | \`${it.itemId}\` | ${cell(it.promoter)} | ${cell(it.title)} | ${cell(it.startLocal)} | ${it.url ? `[link](${it.url})` : "—"} | \`${cell(it.ruleKey)}\` | ${cell(it.snippet)} |`
  );
  const body = [
    `Weekly sample of organizer-feed items our inclusion rules DROPPED, ${sample.windowStart.toISOString().slice(0, 10)} → ${sample.windowEnd.toISOString().slice(0, 10)} (OPE-1634). ${items.length} of ${sample.droppedTotal} dropped items, stratified: one per rule that dropped anything, one per feed that dropped more than half its items, then filled in proportion to each rule's drops.`,
    "",
    "## What to do",
    "",
    "For each item, open the link and judge it, then call `label_dropped_feed_item` with the item id:",
    "",
    '- `verdict: "correct_drop"` — we were right not to list it (a kids\' program, a closure, a private class).',
    '- `verdict: "should_have_been_kept"` — it is a public event we would list. Add a one-line `note` saying why.',
    "",
    'Only "should have been kept" items, or a rule that looks wrong across several items, go to John — as one AGENT BLOCKED comment here listing them. A sample with every item a correct drop closes with no ask.',
    "",
    `Sample id: \`${sample.id}\``,
    "",
    "| # | item id | organizer | title | starts | url | rule | matched text |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  return { title, body };
}

// ── Quality metrics (pure) ───────────────────────────────────────────────────

export interface QualityMetric {
  value: number | null;
  formula: string;
  reason?: string;
}

export interface FeedLabelRow {
  feedId: string;
  label: string;
  ruleKey: string | null;
  included: boolean | null;
  linkBasis: string | null;
  createdAt: Date;
}

export interface FeedQualityItemRow {
  feedId: string;
  linkBasis: string | null;
  eventId: string | null;
  firstSeenAt: Date;
}

export interface FeedDiscrepancyOutcomeRow {
  resolutionStatus: string;
  authoritativeValue: string | null;
  divergentValue: string | null;
  resolvedValue: string | null;
}

export interface FeedQuality {
  labels: { total: number; by_label: Record<string, number>; since_rule: string };
  precision_by_rule: Array<{
    rule: string;
    approved: number;
    rejected: number;
    precision: QualityMetric;
  }>;
  false_drops: {
    by_rule: Array<{
      rule: string;
      correct_drop: number;
      false_drop: number;
      false_drop_rate: QualityMetric;
    }>;
    total: QualityMetric;
  };
  matcher: {
    automatic_links: number;
    wrong_automatic_links: number;
    wrong_match_rate: QualityMetric;
    missed_matches: number;
    items_seen: number;
    missed_match_rate: QualityMetric;
  };
  feed_vs_us: {
    resolved: number;
    feed_right: number;
    us_right: number;
    neither: number;
    dismissed: number;
    open: number;
    feed_right_share: QualityMetric;
    rule: string;
  };
}

const rate = (num: number, den: number, formula: string, none: string): QualityMetric =>
  den > 0 ? { value: num / den, formula } : { value: null, formula, reason: none };

const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

/** Who was right, for one resolved organizer_feed discrepancy. */
export function feedDiscrepancyOutcome(
  d: FeedDiscrepancyOutcomeRow
): "feed_right" | "us_right" | "neither" | "dismissed" | "open" | "other" {
  if (d.resolutionStatus === "open") return "open";
  if (d.resolutionStatus === "dismissed") return "dismissed";
  if (d.resolutionStatus === "resolved_divergent") return "feed_right";
  if (d.resolutionStatus === "resolved_authoritative" || d.resolutionStatus === "self_resolved") {
    // A resolved value that is neither side's says both were wrong.
    if (
      d.resolvedValue != null &&
      norm(d.resolvedValue) !== norm(d.authoritativeValue) &&
      norm(d.resolvedValue) !== norm(d.divergentValue)
    )
      return "neither";
    return "us_right";
  }
  return "other"; // superseded_* bookkeeping: settles nothing about the data
}

export function buildFeedQuality(input: {
  labels: FeedLabelRow[];
  items: FeedQualityItemRow[];
  discrepancies: FeedDiscrepancyOutcomeRow[];
}): FeedQuality {
  const byLabel: Record<string, number> = {};
  for (const l of input.labels) byLabel[l.label] = (byLabel[l.label] ?? 0) + 1;

  const prec = new Map<string, { approved: number; rejected: number }>();
  const drops = new Map<string, { correct_drop: number; false_drop: number }>();
  for (const l of input.labels) {
    const rule = l.ruleKey ?? "unknown";
    if (
      l.included &&
      (l.label === "approved" || l.label === "missed_match" || l.label === "rejected")
    ) {
      const p = prec.get(rule) ?? { approved: 0, rejected: 0 };
      if (l.label === "rejected") p.rejected++;
      else p.approved++;
      prec.set(rule, p);
    }
    if (l.label === "correct_drop" || l.label === "false_drop") {
      const d = drops.get(rule) ?? { correct_drop: 0, false_drop: 0 };
      d[l.label]++;
      drops.set(rule, d);
    }
  }
  const precFormula = "approved (approve + link) / (approved + rejected), included items only";
  const dropFormula = "false_drop / (false_drop + correct_drop), analyst labels on sampled drops";
  const fdTotal = [...drops.values()].reduce((a, d) => a + d.false_drop, 0);
  const cdTotal = [...drops.values()].reduce((a, d) => a + d.correct_drop, 0);

  const autoLinksNow = input.items.filter(
    (i) => i.eventId && isAutomaticLinkBasis(i.linkBasis)
  ).length;
  const wrongAuto = input.labels.filter(
    (l) => l.label === "wrong_match" && isAutomaticLinkBasis(l.linkBasis)
  ).length;
  const missed = byLabel.missed_match ?? 0;

  const outcome = { feed_right: 0, us_right: 0, neither: 0, dismissed: 0, open: 0 };
  for (const d of input.discrepancies) {
    const o = feedDiscrepancyOutcome(d);
    if (o in outcome) outcome[o as keyof typeof outcome]++;
  }
  const resolved = outcome.feed_right + outcome.us_right + outcome.neither;

  return {
    labels: {
      total: input.labels.length,
      by_label: byLabel,
      since_rule:
        "every label since OPE-1634 shipped (labels are not backfilled from older reviews)",
    },
    precision_by_rule: [...prec.entries()]
      .map(([rule, p]) => ({
        rule,
        ...p,
        precision: rate(p.approved, p.approved + p.rejected, precFormula, "no reviewed items yet"),
      }))
      .sort(
        (a, b) =>
          b.approved + b.rejected - (a.approved + a.rejected) || a.rule.localeCompare(b.rule)
      ),
    false_drops: {
      by_rule: [...drops.entries()]
        .map(([rule, d]) => ({
          rule,
          ...d,
          false_drop_rate: rate(
            d.false_drop,
            d.false_drop + d.correct_drop,
            dropFormula,
            "no labels"
          ),
        }))
        .sort((a, b) => b.false_drop - a.false_drop || a.rule.localeCompare(b.rule)),
      total: rate(fdTotal, fdTotal + cdTotal, dropFormula, "no drop sample has been labelled yet"),
    },
    matcher: {
      automatic_links: autoLinksNow + wrongAuto,
      wrong_automatic_links: wrongAuto,
      wrong_match_rate: rate(
        wrongAuto,
        autoLinksNow + wrongAuto,
        "automatic links later unlinked / (automatic links standing + those unlinked)",
        "no automatic link recorded yet (link_basis is written from OPE-1634 on)"
      ),
      missed_matches: missed,
      items_seen: input.items.length,
      missed_match_rate: rate(
        missed,
        input.items.length,
        "reviewer `link`s (a match the matcher missed) / feed items seen",
        "no feed items"
      ),
    },
    feed_vs_us: {
      resolved,
      ...outcome,
      feed_right_share: rate(
        outcome.feed_right,
        resolved,
        "resolved_divergent / (feed right + us right + neither)",
        "no organizer_feed discrepancy has resolved with a winner yet"
      ),
      rule: "resolved_divergent = the feed was right; resolved_authoritative / self_resolved = our listing was, unless the resolved value matches neither side (= neither); dismissed and superseded rows settle nothing",
    },
  };
}

/** Loads the rows buildFeedQuality needs, scoped to the given feeds. */
export async function loadFeedQuality(db: Db, feedIds: string[]): Promise<FeedQuality> {
  if (!feedIds.length) return buildFeedQuality({ labels: [], items: [], discrepancies: [] });
  const labels: FeedLabelRow[] = [];
  const items: FeedQualityItemRow[] = [];
  // Bounded bind lists (D1's 100-parameter cap): feeds are few, but chunk anyway.
  for (let k = 0; k < feedIds.length; k += 50) {
    const ids = feedIds.slice(k, k + 50);
    const l = await db
      .select({
        feedId: feedItemLabels.feedId,
        label: feedItemLabels.label,
        ruleKey: feedItemLabels.ruleKey,
        included: feedItemLabels.included,
        linkBasis: feedItemLabels.linkBasis,
        createdAt: feedItemLabels.createdAt,
      })
      .from(feedItemLabels)
      .where(inArray(feedItemLabels.feedId, ids));
    labels.push(...l.map((r) => ({ ...r, included: r.included == null ? null : !!r.included })));
    items.push(
      ...(await db
        .select({
          feedId: promoterFeedItems.feedId,
          linkBasis: promoterFeedItems.linkBasis,
          eventId: promoterFeedItems.eventId,
          firstSeenAt: promoterFeedItems.firstSeenAt,
        })
        .from(promoterFeedItems)
        .where(inArray(promoterFeedItems.feedId, ids)))
    );
  }
  // Feed-vs-us: discrepancies the feed opened, keyed to the feeds in scope.
  // Chunked like the reads above; an event linked from two feeds is deduped by id.
  const disc = new Map<
    string,
    {
      resolution_status: string;
      authoritative_value: string | null;
      divergent_value: string | null;
      resolved_value: string | null;
    }
  >();
  for (let k = 0; k < feedIds.length; k += 50) {
    const ids = feedIds.slice(k, k + 50);
    const rows = await db.all<{
      id: string;
      resolution_status: string;
      authoritative_value: string | null;
      divergent_value: string | null;
      resolved_value: string | null;
    }>(sql`SELECT d.id, d.resolution_status, d.authoritative_value, d.divergent_value, d.resolved_value
      FROM event_discrepancies d
      WHERE d.detected_by = 'organizer_feed'
        AND EXISTS (SELECT 1 FROM promoter_feed_items i WHERE i.event_id = d.event_id
          AND i.feed_id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `
          )}))`);
    for (const r of rows) disc.set(r.id, r);
  }
  return buildFeedQuality({
    labels,
    items,
    discrepancies: [...disc.values()].map((d) => ({
      resolutionStatus: d.resolution_status,
      authoritativeValue: d.authoritative_value,
      divergentValue: d.divergent_value,
      resolvedValue: d.resolved_value,
    })),
  });
}

/** `organizer_feed:<feed id>` — the source_reliability key for one feed. */
export const feedSourceKey = (feedId: string) => `organizer_feed:${feedId}`;
