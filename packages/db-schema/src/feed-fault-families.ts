/**
 * OPE-1636 — feed analytics 5/5, part A: feed problems as a CPI fault source.
 *
 * Seven fault families, each with a DETECTOR (a read over tables the feed lane
 * already writes), a count over time (per UTC week, Monday-start), and an OWNER
 * lane. READ-ONLY: nothing here writes.
 *
 * Callers, one definition:
 *   - `get_feed_lane_metrics` → `fault_families` (and `retro_section`);
 *   - the CPI drain (`/api/internal/cpi/fileable-signals` → `feedFaultFamilies`),
 *     which also turns the TOP family into one fileable signal once it clears
 *     FEED_FAULT_FILE_THRESHOLD, so its prevention ticket rides the OPE-76 rail.
 *
 * Split like feed-lane-metrics: `buildFeedFaultFamilies` is pure arithmetic over
 * plain occurrence rows (tested without a database), `loadFeedFaultEvents` only
 * fetches them.
 *
 * ── Detector sources (read 2026-11-26) ────────────────────────────────────
 *   feed-fetch-failed       promoter_feed_reads.outcome = 'error' (OPE-1626). The
 *                           read log keeps the newest FEED_READ_LOG_KEEP (200) rows
 *                           per feed, so a very old week can undercount.
 *   feed-format-drift       feed_health_flags.check_name = 'format_drift' (OPE-1633),
 *                           counted when the flag OPENS (first_seen_at).
 *   feed-false-drop         feed_item_labels.label = 'false_drop' (OPE-1634 analyst).
 *   feed-missed-match       feed_item_labels.label = 'missed_match' (review `link`).
 *   feed-wrong-match        feed_item_labels.label = 'wrong_match' (review `unlink`).
 *   feed-duplicate-created  an `event.merge` audit row whose keeper or duplicate is
 *                           an event a feed approval created, merged AFTER the
 *                           approval. The approval set is read from the
 *                           `feed_item.approve*` audit rows' own `event_id`, so it
 *                           covers approvals made before labels existed (OPE-1630).
 *   feed-wrong-venue        an entity_field_history change to events.venue_id on a
 *                           feed-approved event, after the approval.
 */
import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";
import type { FeedLaneMetrics } from "./feed-lane-metrics";

type Db = DrizzleD1Database<typeof schema>;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export const FEED_FAULT_FAMILIES = [
  {
    id: "feed-fetch-failed",
    title: "Feed fetch failed",
    owner: "developer-claude-code",
    detector: "promoter_feed_reads WHERE outcome = 'error', at started_at",
  },
  {
    id: "feed-format-drift",
    title: "Feed format drift",
    owner: "developer-claude-code",
    detector: "feed_health_flags WHERE check_name = 'format_drift', at first_seen_at",
  },
  {
    id: "feed-false-drop",
    title: "Item dropped that should have been kept",
    owner: "analyst-claude-desktop",
    detector: "feed_item_labels WHERE label = 'false_drop', at created_at",
  },
  {
    id: "feed-missed-match",
    title: "Matcher missed an existing listing",
    owner: "developer-claude-code",
    detector: "feed_item_labels WHERE label = 'missed_match' (review link), at created_at",
  },
  {
    id: "feed-wrong-match",
    title: "Matcher linked the wrong listing",
    owner: "developer-claude-code",
    detector: "feed_item_labels WHERE label = 'wrong_match' (review unlink), at created_at",
  },
  {
    id: "feed-duplicate-created",
    title: "Approved feed item duplicated an existing event",
    owner: "developer-claude-code",
    detector:
      "admin_actions 'event.merge' whose keeper or duplicateId is a feed_item.approve* event_id, merged after the approval, at the merge",
  },
  {
    id: "feed-wrong-venue",
    title: "Venue corrected after a feed approval",
    owner: "analyst-claude-desktop",
    detector:
      "entity_field_history (event, venue_id) on a feed_item.approve* event_id, changed after the approval, at changed_at",
  },
] as const;

export type FeedFaultFamilyId = (typeof FEED_FAULT_FAMILIES)[number]["id"];

/** The top family in the window becomes a fileable CPI signal at this count. */
export const FEED_FAULT_FILE_THRESHOLD = 3;
/** Default trend length: 8 weeks, and the "window" the top family is judged on. */
export const FEED_FAULT_WEEKS = 8;
export const FEED_FAULT_WINDOW_DAYS = 30;

/** One detected occurrence. `ref` names the row it came from (for the receipt). */
export interface FeedFaultEvent {
  family: FeedFaultFamilyId;
  at: Date;
  feedId: string | null;
  ref: string;
}

export interface FeedFaultFamilyReport {
  id: FeedFaultFamilyId;
  title: string;
  owner_lane: string;
  detector: string;
  /** Occurrences in the last `window_days`. */
  count_window: number;
  /** Occurrences per UTC week (Monday start), oldest first, `weeks` entries. */
  weekly: Array<{ week_start: string; count: number }>;
  feeds_affected: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface FeedFaultReport {
  generated_at: string;
  window_days: number;
  weeks: number;
  /** Positive landmark (OPE-6 v3.8): how many occurrences the detectors returned at all. */
  occurrences_examined: number;
  families: FeedFaultFamilyReport[];
  /** The family with the most occurrences in the window; null when every family is at 0. */
  top: { id: FeedFaultFamilyId; count_window: number; fileable: boolean } | null;
  file_threshold: number;
}

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStartUtc(ms: number): number {
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0 = Sunday
  const back = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Pure: count the occurrences per family, per week and in the window. */
export function buildFeedFaultFamilies(
  events: FeedFaultEvent[],
  opts: { now: Date; weeks?: number; windowDays?: number }
): FeedFaultReport {
  const weeks = opts.weeks ?? FEED_FAULT_WEEKS;
  const windowDays = opts.windowDays ?? FEED_FAULT_WINDOW_DAYS;
  const nowMs = opts.now.getTime();
  const windowStart = nowMs - windowDays * DAY_MS;
  const thisWeek = weekStartUtc(nowMs);
  const weekStarts = Array.from({ length: weeks }, (_, i) => thisWeek - (weeks - 1 - i) * WEEK_MS);

  const families = FEED_FAULT_FAMILIES.map((f): FeedFaultFamilyReport => {
    const mine = events.filter((e) => e.family === f.id && e.at.getTime() <= nowMs);
    const weekly = weekStarts.map((ws) => ({
      week_start: iso(ws).slice(0, 10),
      count: mine.filter((e) => weekStartUtc(e.at.getTime()) === ws).length,
    }));
    const times = mine.map((e) => e.at.getTime());
    return {
      id: f.id,
      title: f.title,
      owner_lane: f.owner,
      detector: f.detector,
      count_window: mine.filter((e) => e.at.getTime() >= windowStart).length,
      weekly,
      feeds_affected: new Set(mine.map((e) => e.feedId).filter(Boolean)).size,
      first_seen_at: times.length ? iso(Math.min(...times)) : null,
      last_seen_at: times.length ? iso(Math.max(...times)) : null,
    };
  });

  // Ties break by registry order, so the top family is deterministic.
  let top: FeedFaultReport["top"] = null;
  for (const f of families) {
    if (f.count_window > 0 && (!top || f.count_window > top.count_window)) {
      top = { id: f.id, count_window: f.count_window, fileable: false };
    }
  }
  if (top) top.fileable = top.count_window >= FEED_FAULT_FILE_THRESHOLD;

  return {
    generated_at: iso(nowMs),
    window_days: windowDays,
    weeks,
    occurrences_examined: events.length,
    families,
    top,
    file_threshold: FEED_FAULT_FILE_THRESHOLD,
  };
}

/** The CPI fingerprint the top family files under (OPE-76 `cpi:<source>:<refKey>`). */
export const feedFaultFingerprint = (id: FeedFaultFamilyId) => `cpi:feed:${id}`;

// ── Loader ───────────────────────────────────────────────────────────────────

interface Row {
  family: string;
  at: number;
  feed_id: string | null;
  ref: string;
}

/**
 * Fetch every occurrence since `since`. One statement per source, no IN-lists
 * (the approval set is a join, so D1's 100-parameter cap cannot bite). Raw-SQL
 * timestamps are SECONDS in D1.
 */
export async function loadFeedFaultEvents(db: Db, since: Date): Promise<FeedFaultEvent[]> {
  const s = Math.floor(since.getTime() / 1000);
  const approvals = sql`SELECT json_extract(a.payload_json, '$.event_id') AS event_id,
      json_extract(a.payload_json, '$.feed_id') AS feed_id, a.created_at AS approved_at
    FROM admin_actions a
    WHERE a.action IN ('feed_item.approve', 'feed_item.approve_as_occurrence')
      AND json_extract(a.payload_json, '$.event_id') IS NOT NULL`;
  const queries = [
    sql`SELECT 'feed-fetch-failed' AS family, started_at AS at, feed_id, id AS ref
      FROM promoter_feed_reads WHERE outcome = 'error' AND started_at >= ${s}`,
    sql`SELECT 'feed-format-drift' AS family, first_seen_at AS at, feed_id, id AS ref
      FROM feed_health_flags WHERE check_name = 'format_drift' AND first_seen_at >= ${s}`,
    sql`SELECT CASE label WHEN 'false_drop' THEN 'feed-false-drop'
        WHEN 'missed_match' THEN 'feed-missed-match' ELSE 'feed-wrong-match' END AS family,
        created_at AS at, feed_id, id AS ref
      FROM feed_item_labels
      WHERE label IN ('false_drop', 'missed_match', 'wrong_match') AND created_at >= ${s}`,
    sql`SELECT DISTINCT 'feed-duplicate-created' AS family, m.created_at AS at, ap.feed_id, m.id AS ref
      FROM admin_actions m
      JOIN (${approvals}) ap
        ON (ap.event_id = m.target_id OR ap.event_id = json_extract(m.payload_json, '$.duplicateId'))
      WHERE m.action = 'event.merge' AND m.created_at >= ${s} AND m.created_at > ap.approved_at`,
    sql`SELECT DISTINCT 'feed-wrong-venue' AS family, h.changed_at AS at, ap.feed_id, h.id AS ref
      FROM entity_field_history h
      JOIN (${approvals}) ap ON ap.event_id = h.entity_id
      WHERE h.entity_type = 'event' AND h.field = 'venue_id'
        AND h.changed_at >= ${s} AND h.changed_at > ap.approved_at`,
  ];
  const out: FeedFaultEvent[] = [];
  for (const q of queries) {
    const rows = await db.all<Row>(q);
    for (const r of rows) {
      out.push({
        family: r.family as FeedFaultFamilyId,
        at: new Date(Number(r.at) * 1000),
        feedId: r.feed_id ?? null,
        ref: String(r.ref),
      });
    }
  }
  return out;
}

export async function loadFeedFaultFamilies(
  db: Db,
  opts: { now: Date; weeks?: number; windowDays?: number }
): Promise<FeedFaultReport> {
  const weeks = opts.weeks ?? FEED_FAULT_WEEKS;
  const windowDays = opts.windowDays ?? FEED_FAULT_WINDOW_DAYS;
  const oldestWeek = weekStartUtc(opts.now.getTime()) - (weeks - 1) * WEEK_MS;
  const since = new Date(Math.min(oldestWeek, opts.now.getTime() - windowDays * DAY_MS));
  const events = await loadFeedFaultEvents(db, since);
  return buildFeedFaultFamilies(events, { now: opts.now, weeks, windowDays });
}

// ── The monthly retro's "Feeds" section ─────────────────────────────────────

/** A CPI ledger row for the top family's fingerprint, if one exists. */
export interface FeedPreventionTicket {
  opeId: string | null;
  status: string;
}

const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${Math.round(v * 1000) / 10}%`);

/**
 * Pure: render the CPI monthly retro's "Feeds" section (markdown) from
 * `get_feed_lane_metrics` output plus the fault report. Every line comes from a
 * number already in the inputs; an unmeasured rate prints "n/a (<reason>)".
 */
export function feedRetroSection(
  m: FeedLaneMetrics,
  faults: FeedFaultReport,
  prevention: FeedPreventionTicket | null
): string {
  const L: string[] = [];
  L.push(`## Feeds (get_feed_lane_metrics, window ${m.window.days}d, generated ${m.generated_at})`);
  L.push("");
  L.push(
    `**Feeds:** ${m.feeds.registered} registered, ${m.feeds.enabled} enabled, ${m.feeds.healthy} healthy (${m.feeds.healthy_rule}).`
  );
  L.push("");
  L.push("**Funnel**");
  for (const s of m.total.funnel.steps) {
    const r = s.rate == null ? "" : ` (${pct(s.rate)} of ${s.rate_base})`;
    L.push(`- ${s.step}: ${s.count == null ? `n/a (${s.reason ?? "unmeasured"})` : s.count}${r}`);
  }
  const b = m.total.backlog;
  L.push(
    `- review backlog: ${b.awaiting_review.value ?? 0} awaiting, ${b.older_than_target.value ?? 0} past the ${b.target_days}-day target`
  );
  L.push(
    `- new to us: ${m.coverage.new_to_us.value ?? "n/a"} (${m.coverage.new_to_us_7d.value ?? 0} this week)`
  );
  L.push("");
  L.push("**Quality**");
  const q = m.quality;
  if (!q) {
    L.push("- not loaded");
  } else {
    L.push(
      `- labels: ${q.labels.total} (${
        Object.entries(q.labels.by_label)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      })`
    );
    const fd = q.false_drops.total;
    L.push(`- false-drop rate: ${fd.value == null ? `n/a (${fd.reason})` : pct(fd.value)}`);
    const wm = q.matcher.wrong_match_rate;
    const mm = q.matcher.missed_match_rate;
    L.push(
      `- matcher: wrong ${wm.value == null ? `n/a (${wm.reason})` : pct(wm.value)} of ${q.matcher.automatic_links} automatic links; missed ${mm.value == null ? `n/a (${mm.reason})` : pct(mm.value)} of ${q.matcher.items_seen} items`
    );
    const fv = q.feed_vs_us;
    L.push(
      `- feed vs us: ${fv.resolved} resolved (feed right ${fv.feed_right}, us right ${fv.us_right}, neither ${fv.neither}); ${fv.open} open`
    );
  }
  L.push("");
  const flags = m.feeds.open_health_flags;
  L.push(`**Open health flags:** ${flags.length === 0 ? "none" : ""}`);
  for (const f of flags)
    L.push(`- ${f.promoter ?? f.feed_id}: ${f.check} since ${f.first_seen_at.slice(0, 10)}`);
  L.push("");
  const rc = m.rule_changes ?? [];
  L.push(`**Rule changes:** ${rc.length === 0 ? "none recorded" : ""}`);
  for (const c of rc) {
    const before = c.metrics_before?.false_drops?.total?.value as number | null | undefined;
    const after = c.metrics_after?.false_drops?.total?.value as number | null | undefined;
    const effect = c.metrics_after
      ? `false-drop rate ${pct(before)} → ${pct(after)}`
      : `effect due ${c.after_due_at.slice(0, 10)}`;
    L.push(
      `- ${c.changed_at.slice(0, 10)} ${c.kind}${c.pr ? ` (${c.pr})` : ""}: ${c.summary} — ${effect}`
    );
  }
  L.push("");
  L.push(
    `**Fault families** (last ${faults.window_days}d; weekly trend over ${faults.weeks} weeks; ${faults.occurrences_examined} occurrences examined)`
  );
  for (const f of faults.families) {
    L.push(
      `- ${f.id}: ${f.count_window} [${f.weekly.map((w) => w.count).join(" ")}] · owner ${f.owner_lane}`
    );
  }
  if (!faults.top) {
    L.push("", "**Top fault family:** none — every family is at 0 in the window.");
  } else {
    const t = faults.top;
    const ticket = prevention?.opeId
      ? `${prevention.opeId} (${prevention.status})`
      : t.fileable
        ? "proposed on the CPI rail — file it from cpi_fileable_signals"
        : `none — below the auto-file threshold of ${faults.file_threshold}; the retro decides whether to file one`;
    L.push("", `**Top fault family:** ${t.id} (${t.count_window}). Prevention ticket: ${ticket}.`);
  }
  return L.join("\n");
}

/** The CPI ledger row (cpi_signal_filings) for a family's fingerprint, or null. */
export async function loadFeedPreventionTicket(
  db: Db,
  id: FeedFaultFamilyId
): Promise<FeedPreventionTicket | null> {
  const [row] = await db
    .select({ opeId: schema.cpiSignalFilings.opeId, status: schema.cpiSignalFilings.status })
    .from(schema.cpiSignalFilings)
    .where(eq(schema.cpiSignalFilings.fingerprint, feedFaultFingerprint(id)))
    .limit(1);
  return row ?? null;
}
