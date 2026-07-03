/**
 * Activity domain loaders: the merged recent-activity feed, this-week's
 * admin actions, the §6.3 action queue, the publishing sparkline, and the
 * account-engagement card.
 */

import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  adminActions,
  analyticsEvents,
  indexnowSubmissions,
  kpiStateHistory,
  recommendationRules,
  userFavorites,
} from "@/lib/db/schema";
import {
  KPI_THRESHOLDS,
  actionTitleForKpi,
  formatStaleAge,
  type KpiName,
} from "@/lib/kpi-thresholds";
import type { KpiStateRow } from "@/lib/kpi-states";
import { tierFor } from "@/lib/recommendations/tiers";
import { actionQueueSla, compareActionQueueEntries } from "./action-queue-sla";
import { CONVERSION_EVENT_NAMES, SPARKLINE_DAYS, fillDailySeries, type Db } from "./shared";
import type {
  AccountEngagementCard,
  ActionQueueEntry,
  ActivityEntry,
  SparklinePoint,
  ThisWeeksActionsCard,
} from "./types";

const HIGH_PRIORITY_INDEXNOW_SOURCES = ["venue.create", "vendor.create", "event.approve"] as const;

export async function loadPublishingSparkline(db: Db, sinceDate: Date): Promise<SparklinePoint[]> {
  // Publishing activity = successful IndexNow submissions per day. Reflects
  // how often we ship indexable content (event approvals, new venues, etc.)
  // and the cache TTL hides this from GSC for ~24h, so this is the freshest
  // proxy available. strftime expects seconds; columns store seconds.
  const dayExpr = sql<string>`strftime('%Y-%m-%d', ${indexnowSubmissions.timestamp}, 'unixepoch')`;
  const rows = await db
    .select({
      day: dayExpr,
      c: count(),
    })
    .from(indexnowSubmissions)
    .where(
      and(gte(indexnowSubmissions.timestamp, sinceDate), eq(indexnowSubmissions.status, "success"))
    )
    .groupBy(dayExpr);

  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.day, r.c);
  return fillDailySeries(byDate, SPARKLINE_DAYS);
}

// ── Row 4 — Activity feed ──────────────────────────────────────────

export async function loadActivity(db: Db, sinceDate: Date): Promise<ActivityEntry[]> {
  const limit = 20;

  const [adminRows, indexnowRows, conversionRows] = await Promise.all([
    db
      .select({
        id: adminActions.id,
        action: adminActions.action,
        actorUserId: adminActions.actorUserId,
        targetType: adminActions.targetType,
        targetId: adminActions.targetId,
        createdAt: adminActions.createdAt,
      })
      .from(adminActions)
      .where(gte(adminActions.createdAt, sinceDate))
      .orderBy(desc(adminActions.createdAt))
      .limit(limit),
    db
      .select({
        id: indexnowSubmissions.id,
        source: indexnowSubmissions.source,
        urls: indexnowSubmissions.urls,
        status: indexnowSubmissions.status,
        timestamp: indexnowSubmissions.timestamp,
      })
      .from(indexnowSubmissions)
      .where(
        and(
          gte(indexnowSubmissions.timestamp, sinceDate),
          inArray(indexnowSubmissions.source, [...HIGH_PRIORITY_INDEXNOW_SOURCES]),
          eq(indexnowSubmissions.status, "success")
        )
      )
      .orderBy(desc(indexnowSubmissions.timestamp))
      .limit(limit),
    db
      .select({
        id: analyticsEvents.id,
        eventName: analyticsEvents.eventName,
        properties: analyticsEvents.properties,
        timestamp: analyticsEvents.timestamp,
      })
      .from(analyticsEvents)
      .where(
        and(
          inArray(analyticsEvents.eventName, [...CONVERSION_EVENT_NAMES]),
          gte(analyticsEvents.timestamp, sinceDate)
        )
      )
      .orderBy(desc(analyticsEvents.timestamp))
      .limit(limit),
  ]);

  const merged: ActivityEntry[] = [];

  for (const r of adminRows) {
    // All three source columns are Date objects (Drizzle mode:"timestamp" reads as Date);
    // .getTime() everywhere, no more dual-format normalization needed.
    merged.push({
      ts: (r.createdAt as Date).getTime(),
      kind: "admin",
      description: `${r.action} on ${r.targetType} ${r.targetId.slice(0, 8)}`,
      actor: r.actorUserId ? r.actorUserId.slice(0, 8) : null,
    });
  }

  for (const r of indexnowRows) {
    let firstUrl: string | null = null;
    try {
      const arr = JSON.parse(r.urls) as string[];
      if (Array.isArray(arr) && arr.length > 0) firstUrl = arr[0];
    } catch {
      // ignore — leave firstUrl null
    }
    merged.push({
      ts: r.timestamp.getTime(),
      kind: "indexnow",
      description: `IndexNow ${r.source}${firstUrl ? ` · ${firstUrl}` : ""}`,
      href: firstUrl ?? undefined,
    });
  }

  for (const r of conversionRows) {
    let slug: string | null = null;
    let url: string | null = null;
    try {
      const props = JSON.parse(r.properties ?? "{}") as {
        eventSlug?: string;
        destinationUrl?: string;
      };
      slug = props.eventSlug ?? null;
      url = props.destinationUrl ?? null;
    } catch {
      // ignore
    }
    const label = r.eventName === "outbound_ticket_click" ? "Ticket click" : "Application click";
    merged.push({
      ts: r.timestamp.getTime(),
      kind: "conversion",
      description: `${label}${slug ? ` · ${slug}` : ""}`,
      href: url ?? undefined,
    });
  }

  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, 10);
}

export async function loadAccountEngagement(
  db: Db,
  sinceDate: Date,
  days: number
): Promise<AccountEngagementCard> {
  // Renamed from the old multi-numerator "conversion rate". Tracks Enhanced
  // Profile / engagement funnel: claims + event favorites + contact clicks
  // per first-party analytics event in the window.
  const [claimsRow, favRow, contactRow, sessionRow] = await Promise.all([
    db
      .select({ n: count() })
      .from(adminActions)
      .where(
        and(
          eq(adminActions.action, "vendor.claim_self_serve"),
          gte(adminActions.createdAt, sinceDate)
        )
      ),
    db
      .select({ n: count() })
      .from(userFavorites)
      .where(
        and(eq(userFavorites.favoritableType, "EVENT"), gte(userFavorites.createdAt, sinceDate))
      ),
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.eventName, "outbound_contact_click"),
          gte(analyticsEvents.timestamp, sinceDate)
        )
      ),
    db
      .select({ n: count() })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.timestamp, sinceDate)),
  ]);
  const vendor_claims = claimsRow[0]?.n ?? 0;
  const event_favorites = favRow[0]?.n ?? 0;
  const contact_clicks = contactRow[0]?.n ?? 0;
  const signals = vendor_claims + event_favorites + contact_clicks;
  const sessions = sessionRow[0]?.n ?? 0;
  const rate = sessions > 0 ? signals / sessions : 0;
  return {
    signals,
    sessions,
    rate,
    windowDays: days,
    breakdown: { vendor_claims, event_favorites, contact_clicks },
  };
}

export async function loadThisWeeksActions(db: Db, sinceDate: Date): Promise<ThisWeeksActionsCard> {
  const rows = await db
    .select({
      action: adminActions.action,
      actorUserId: adminActions.actorUserId,
      targetType: adminActions.targetType,
      targetId: adminActions.targetId,
      createdAt: adminActions.createdAt,
    })
    .from(adminActions)
    .where(gte(adminActions.createdAt, sinceDate))
    .orderBy(desc(adminActions.createdAt))
    .limit(20);
  const [countRow] = await db
    .select({ n: count() })
    .from(adminActions)
    .where(gte(adminActions.createdAt, sinceDate));
  return {
    count: countRow?.n ?? 0,
    actions: rows.map((r) => ({
      action: r.action,
      actorUserId: r.actorUserId,
      targetType: r.targetType,
      targetId: r.targetId,
      createdAt: r.createdAt.getTime(),
    })),
  };
}

/**
 * §6.3 action queue. Derives a prioritized list of P0/P1 entries from the
 * latest KPI states + Tier-1 recommendation rules with affected_count >= 50.
 *
 * P0: each KPI in RED → one entry per KPI (KPIs that have been RED for many
 *     days still surface, but `firstDetectedAt` makes the staleness visible).
 * P1: each KPI in YELLOW that wasn't RED any time in the last 7 days. Once
 *     a RED→YELLOW transition stabilizes for a week, it re-enters the queue
 *     so the team is reminded to keep pushing it back to GREEN.
 * P1: each Tier-1 recommendation rule with totalMatchCount >= 50.
 *
 * Auto-resolution: when a KPI returns to GREEN, the recompute job writes a
 * `kpi.state_resolved` row to admin_actions; this loader simply omits the
 * GREEN/INDETERMINATE KPI from the queue. The Recent Activity panel surfaces
 * the resolution from admin_actions.
 */
const TIER_1_REC_AFFECTED_THRESHOLD = 50;

export async function loadActionQueue(
  db: Db,
  kpiStates: Map<KpiName, KpiStateRow>
): Promise<ActionQueueEntry[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000);
  const [redInLast7d, hotRecs] = await Promise.all([
    // One query that lists which KPIs were RED at any point in the last 7d.
    // Used to suppress YELLOW→P1 entries for KPIs that just stabilized.
    db
      .selectDistinct({ kpiName: kpiStateHistory.kpiName })
      .from(kpiStateHistory)
      .where(and(eq(kpiStateHistory.state, "RED"), gte(kpiStateHistory.computedAt, sevenDaysAgo))),
    // Tier-1 recommendation rules with >= 50 affected items.
    db
      .select({
        ruleKey: recommendationRules.ruleKey,
        title: recommendationRules.title,
        totalMatchCount: recommendationRules.totalMatchCount,
        enabled: recommendationRules.enabled,
      })
      .from(recommendationRules)
      .where(
        and(
          eq(recommendationRules.enabled, true),
          gte(recommendationRules.totalMatchCount, TIER_1_REC_AFFECTED_THRESHOLD)
        )
      ),
  ]);
  const redRecently = new Set(redInLast7d.map((r) => r.kpiName));

  // OPE-78 — build entries WITHOUT the derived SLA fields, then decorate + sort
  // once below (age all items against a single `now`).
  const base: Omit<ActionQueueEntry, "hoursInRed" | "slaStatus">[] = [];

  // Stable KPI ordering — matches KPI_NAMES so the queue doesn't reshuffle
  // visually as states flip between fires.
  for (const [kpi, row] of kpiStates) {
    const t = KPI_THRESHOLDS[kpi];
    if (row.state === "STALE") {
      // STALE = data feed is broken. Surface as P0 with a "fix the source"
      // prompt — broken data invalidates GREEN/YELLOW/RED entirely.
      const meta = row.meta as { dataAgeSeconds?: number } | null;
      const ageSec = meta?.dataAgeSeconds;
      const ageLabel = typeof ageSec === "number" ? formatStaleAge(ageSec) : "unknown";
      base.push({
        priority: "P0",
        source: "kpi",
        title: `${t.displayName} data feed stale (${ageLabel})`,
        effort: "Investigate data source",
        href: t.href,
        firstDetectedAt: row.firstDetectedAt?.toISOString() ?? null,
        refKey: kpi,
      });
    } else if (row.state === "RED") {
      base.push({
        priority: "P0",
        source: "kpi",
        title: actionTitleForKpi(kpi, row.value),
        effort: t.effort,
        href: t.href,
        firstDetectedAt: row.firstDetectedAt?.toISOString() ?? null,
        refKey: kpi,
      });
    } else if (row.state === "YELLOW" && !redRecently.has(kpi)) {
      base.push({
        priority: "P1",
        source: "kpi",
        title: actionTitleForKpi(kpi, row.value),
        effort: t.effort,
        href: t.href,
        firstDetectedAt: row.firstDetectedAt?.toISOString() ?? null,
        refKey: kpi,
      });
    }
  }

  for (const rule of hotRecs) {
    if (tierFor(rule.ruleKey) !== "T1") continue;
    base.push({
      priority: "P1",
      source: "recommendation",
      title: `Activate ${rule.title}: ${rule.totalMatchCount ?? 0} affected`,
      effort: "Marketing / Ops",
      href: `/admin/recommendations`,
      firstDetectedAt: null,
      refKey: rule.ruleKey,
    });
  }

  // OPE-78 — decorate each entry with age-in-red + SLA state (one `now` so all
  // items age against the same instant), then default-sort oldest-breach-first
  // (see compareActionQueueEntries).
  const now = new Date();
  const entries: ActionQueueEntry[] = base.map((e) => ({
    ...e,
    ...actionQueueSla(e.priority, e.firstDetectedAt, now),
  }));
  entries.sort(compareActionQueueEntries);
  return entries;
}
