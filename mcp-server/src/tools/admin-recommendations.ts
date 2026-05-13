import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  recommendationItems,
  recommendationRules,
  events,
  vendors,
  venues,
  promoters,
} from "../schema.js";
import { jsonContent, publicUrlFor } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

// Mirror src/lib/recommendations/tiers.ts. Kept in sync by hand because the
// main app's tier map isn't published as a shared package; if a new T1/T2 rule
// is added there, mirror it here too. Unmapped rules default to T3 (matches
// tierFor()'s fallback) so the mirror is fail-safe — drift means a T1/T2 rule
// shows up as T3 in MCP, never the reverse (no spurious revenue alarms).
const TIER_BY_RULE_KEY: Record<string, "T1" | "T2" | "T3"> = {
  enhanced_profile_cohort: "T1",
  standards_eligible_for_claim_outreach: "T1",
  claimed_ready_for_enhanced_upsell: "T1",
  enhanced_profile_renewals: "T1",
  enhanced_profile_renewal_critical: "T1",
  enhanced_profile_renewal_warning: "T1",
  enhanced_profile_renewal_notice: "T1",
  hijacked_domain_detection: "T2",
  competitor_url_contamination: "T2",
  cannibalization_detection: "T2",
  vendors_no_description: "T3",
  vendors_short_description: "T3",
  stubs_ready_for_enrichment: "T3",
  confirm_past_event_occurrence: "T3",
};

function tierFor(ruleKey: string): "T1" | "T2" | "T3" {
  return TIER_BY_RULE_KEY[ruleKey] ?? "T3";
}

// Mirrors engine.ts ACTIVE_WINDOW_MS. Items not refreshed in this window drop
// out of the active list — engine relies on it as a safety net for rules that
// don't set autoResolve.
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Year-9999 snooze-forever sentinel from engine.ts. Anything stored with a
// dismissed_until past this threshold is "snooze forever", not a time-bounded
// snooze. We surface this as a flag in the response so callers don't have to
// interpret raw epoch values.
const SNOOZE_FOREVER_THRESHOLD_MS = new Date("9999-01-01").getTime();

type Status = "active" | "snoozed" | "resolved";

interface RecommendationItemOut {
  id: string;
  entity_type: string;
  entity_id: string | null;
  label: string;
  detail_url: string | null;
  payload: Record<string, unknown> | null;
  first_seen_at: number;
  last_seen_at: number;
  dismissed_until: number | null;
  snoozed_forever: boolean;
  acted_at: number | null;
}

interface RecommendationRuleOut {
  rule_slug: string;
  title: string;
  rationale_template: string;
  severity: string;
  category: string | null;
  tier: "T1" | "T2" | "T3";
  enabled: boolean;
  total_match_count: number;
  affected_count: number;
  last_scanned_at: number | null;
  last_scan_error: string | null;
  affected_items?: RecommendationItemOut[];
}

interface RawRow {
  itemId: string;
  ruleId: string;
  ruleKey: string;
  title: string;
  rationaleTemplate: string;
  severity: string;
  category: string | null;
  enabled: boolean;
  totalMatchCount: number | null;
  lastScannedAt: Date | null;
  lastScanError: string | null;
  targetType: string;
  targetId: string | null;
  payloadJson: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  dismissedUntil: Date | null;
  actedAt: Date | null;
}

function statusPredicate(status: Status, now: Date) {
  const nowMs = now.getTime();
  if (status === "active") {
    const cutoff = new Date(nowMs - ACTIVE_WINDOW_MS);
    // dismissed_until is stored as seconds-epoch (Drizzle mode:"timestamp").
    // Engine.ts compares against now.getTime() (ms) which is a latent bug —
    // documented and re-verified 2026-05-13 against live D1, see commit
    // message for details. We compare in seconds to match storage units.
    // (The Drizzle eq/gt/lt helpers handle the conversion automatically when
    // bound to a Date; only raw sql`` template literals need explicit handling.)
    const nowSeconds = Math.floor(nowMs / 1000);
    return and(
      gte(recommendationItems.lastSeenAt, cutoff),
      isNull(recommendationItems.actedAt),
      or(
        isNull(recommendationItems.dismissedUntil),
        sql`${recommendationItems.dismissedUntil} < ${nowSeconds}`
      ),
      eq(recommendationRules.enabled, true)
    );
  }
  if (status === "snoozed") {
    return and(
      isNull(recommendationItems.actedAt),
      isNotNull(recommendationItems.dismissedUntil),
      gt(recommendationItems.dismissedUntil, now)
    );
  }
  // resolved
  return isNotNull(recommendationItems.actedAt);
}

async function loadEntityLabels(
  db: Db,
  rows: RawRow[]
): Promise<Map<string, { label: string; slug: string | null }>> {
  // Bucket target_ids by target_type so we can issue one SELECT per entity
  // table rather than N queries. Most rules target one or two types, so this
  // is typically 1-2 batch SELECTs total.
  const byType: Record<string, Set<string>> = {};
  for (const r of rows) {
    if (!r.targetId) continue;
    if (!["event", "vendor", "venue", "promoter"].includes(r.targetType)) continue;
    (byType[r.targetType] ??= new Set()).add(r.targetId);
  }

  const result = new Map<string, { label: string; slug: string | null }>();

  if (byType.event?.size) {
    const ids = [...byType.event];
    const rows2 = await db
      .select({ id: events.id, name: events.name, slug: events.slug })
      .from(events)
      .where(inArray(events.id, ids));
    for (const r of rows2) result.set(`event:${r.id}`, { label: r.name, slug: r.slug });
  }
  if (byType.vendor?.size) {
    const ids = [...byType.vendor];
    const rows2 = await db
      .select({ id: vendors.id, name: vendors.businessName, slug: vendors.slug })
      .from(vendors)
      .where(inArray(vendors.id, ids));
    for (const r of rows2) result.set(`vendor:${r.id}`, { label: r.name, slug: r.slug });
  }
  if (byType.venue?.size) {
    const ids = [...byType.venue];
    const rows2 = await db
      .select({ id: venues.id, name: venues.name, slug: venues.slug })
      .from(venues)
      .where(inArray(venues.id, ids));
    for (const r of rows2) result.set(`venue:${r.id}`, { label: r.name, slug: r.slug });
  }
  if (byType.promoter?.size) {
    const ids = [...byType.promoter];
    const rows2 = await db
      .select({ id: promoters.id, name: promoters.companyName, slug: promoters.slug })
      .from(promoters)
      .where(inArray(promoters.id, ids));
    for (const r of rows2) result.set(`promoter:${r.id}`, { label: r.name, slug: r.slug });
  }

  return result;
}

function detailUrlFor(
  targetType: string,
  slug: string | null,
  payload: Record<string, unknown> | null
): string | null {
  switch (targetType) {
    case "event":
      return slug ? publicUrlFor("events", slug) : null;
    case "vendor":
      return slug ? publicUrlFor("vendors", slug) : null;
    case "venue":
      return slug ? publicUrlFor("venues", slug) : null;
    case "promoter":
      return slug ? publicUrlFor("promoters", slug) : null;
    case "static_page": {
      // Static-page rules store the page path in payload.path or payload.url.
      const p =
        typeof payload?.path === "string"
          ? (payload.path as string)
          : typeof payload?.url === "string"
            ? (payload.url as string)
            : null;
      if (!p) return null;
      return p.startsWith("http") ? p : `https://meetmeatthefair.com${p}`;
    }
    case "gsc_query":
    case "recommendation_item":
    default:
      return null;
  }
}

function fallbackLabel(targetType: string, payload: Record<string, unknown> | null): string {
  // Payload-based label for target types that don't reference an entity table.
  // Prefer human-readable fields the rules already include.
  for (const key of ["query", "businessName", "name", "title", "page", "path", "url"]) {
    const v = payload?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return `(${targetType})`;
}

function shapeItem(
  r: RawRow,
  labels: Map<string, { label: string; slug: string | null }>
): RecommendationItemOut {
  let payload: Record<string, unknown> | null = null;
  if (r.payloadJson) {
    try {
      payload = JSON.parse(r.payloadJson) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  const looked = r.targetId ? labels.get(`${r.targetType}:${r.targetId}`) : undefined;
  const label = looked?.label ?? fallbackLabel(r.targetType, payload);
  const slug = looked?.slug ?? null;
  const dismissedMs = r.dismissedUntil?.getTime() ?? null;
  return {
    id: r.itemId,
    entity_type: r.targetType,
    entity_id: r.targetId,
    label,
    detail_url: detailUrlFor(r.targetType, slug, payload),
    payload,
    first_seen_at: Math.floor(r.firstSeenAt.getTime() / 1000),
    last_seen_at: Math.floor(r.lastSeenAt.getTime() / 1000),
    dismissed_until: dismissedMs !== null ? Math.floor(dismissedMs / 1000) : null,
    snoozed_forever: dismissedMs !== null && dismissedMs >= SNOOZE_FOREVER_THRESHOLD_MS,
    acted_at: r.actedAt ? Math.floor(r.actedAt.getTime() / 1000) : null,
  };
}

function groupByRule(
  rows: RawRow[],
  itemsByRule: Map<string, RecommendationItemOut[]>,
  includeItems: boolean
): RecommendationRuleOut[] {
  const seen = new Map<string, RecommendationRuleOut>();
  for (const r of rows) {
    if (seen.has(r.ruleId)) continue;
    seen.set(r.ruleId, {
      rule_slug: r.ruleKey,
      title: r.title,
      rationale_template: r.rationaleTemplate,
      severity: r.severity,
      category: r.category,
      tier: tierFor(r.ruleKey),
      enabled: r.enabled,
      total_match_count: r.totalMatchCount ?? 0,
      affected_count: itemsByRule.get(r.ruleId)?.length ?? 0,
      last_scanned_at: r.lastScannedAt ? Math.floor(r.lastScannedAt.getTime() / 1000) : null,
      last_scan_error: r.lastScanError,
      ...(includeItems ? { affected_items: itemsByRule.get(r.ruleId) ?? [] } : {}),
    });
  }
  return [...seen.values()];
}

async function fetchRecommendationsRaw(
  db: Db,
  opts: { status: Status; ruleSlug?: string; limit: number }
): Promise<RawRow[]> {
  const now = new Date();
  const baseWhere = statusPredicate(opts.status, now);
  const where = opts.ruleSlug
    ? and(baseWhere, eq(recommendationRules.ruleKey, opts.ruleSlug))
    : baseWhere;

  return db
    .select({
      itemId: recommendationItems.id,
      ruleId: recommendationRules.id,
      ruleKey: recommendationRules.ruleKey,
      title: recommendationRules.title,
      rationaleTemplate: recommendationRules.rationaleTemplate,
      severity: recommendationRules.severity,
      category: recommendationRules.category,
      enabled: recommendationRules.enabled,
      totalMatchCount: recommendationRules.totalMatchCount,
      lastScannedAt: recommendationRules.lastScannedAt,
      lastScanError: recommendationRules.lastScanError,
      targetType: recommendationItems.targetType,
      targetId: recommendationItems.targetId,
      payloadJson: recommendationItems.payloadJson,
      firstSeenAt: recommendationItems.firstSeenAt,
      lastSeenAt: recommendationItems.lastSeenAt,
      dismissedUntil: recommendationItems.dismissedUntil,
      actedAt: recommendationItems.actedAt,
    })
    .from(recommendationItems)
    .innerJoin(recommendationRules, eq(recommendationItems.ruleId, recommendationRules.id))
    .where(where)
    .limit(opts.limit);
}

export function registerRecommendationsTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_recommendations",
    [
      "Read the admin recommendations feed (the same data that powers /admin/analytics ▸ Recommendations).",
      "Returns rules grouped by rule_slug with their affected items. Tier mapping mirrors src/lib/recommendations/tiers.ts.",
      "Status 'active' matches the dashboard's default view (last_seen_at within 7 days, not acted, not currently snoozed).",
      "Read-only — snooze/dismiss/acted dispositions remain admin-UI only.",
    ].join(" "),
    {
      tier: z
        .enum(["T1", "T2", "T3"])
        .optional()
        .describe("Filter to one impact tier. T1=revenue, T2=SEO defense, T3=content quality."),
      status: z
        .enum(["active", "snoozed", "resolved"])
        .optional()
        .default("active")
        .describe(
          "active (default) | snoozed (admin dismissed, still in window) | resolved (acted_at set)."
        ),
      rule_slug: z
        .string()
        .optional()
        .describe(
          "Restrict to one rule (its rule_key, e.g. 'vendors_no_description'). For full single-rule history, use get_recommendation_rule."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(50)
        .describe("Max items (not rules) returned. Default 50, cap 500."),
      include_items: z
        .boolean()
        .optional()
        .default(true)
        .describe("Set false to get rule-level counts only (lighter payload for summaries)."),
    },
    async (params) => {
      const { tier, status, rule_slug, limit, include_items } = params;
      const rows = await fetchRecommendationsRaw(db, {
        status,
        ruleSlug: rule_slug,
        limit,
      });

      // Tier filter applied after the SELECT because tier is derived from
      // rule_key in app code, not stored on the row. Filtering 23 rule_keys
      // in memory is cheaper than maintaining a tier column.
      const tierFiltered = tier ? rows.filter((r) => tierFor(r.ruleKey) === tier) : rows;

      const labels = await loadEntityLabels(db, tierFiltered);
      const itemsByRule = new Map<string, RecommendationItemOut[]>();
      for (const r of tierFiltered) {
        const arr = itemsByRule.get(r.ruleId) ?? [];
        arr.push(shapeItem(r, labels));
        itemsByRule.set(r.ruleId, arr);
      }

      const grouped = groupByRule(tierFiltered, itemsByRule, include_items);
      // Sort by tier then severity then affected_count desc — same ordering
      // the admin UI uses.
      const sevWeight = (s: string) => (s === "red" ? 3 : s === "yellow" ? 2 : 1);
      grouped.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
        const sd = sevWeight(b.severity) - sevWeight(a.severity);
        if (sd !== 0) return sd;
        return b.affected_count - a.affected_count;
      });

      return {
        content: [
          jsonContent({
            status,
            tier_filter: tier ?? null,
            rule_slug_filter: rule_slug ?? null,
            total_items: tierFiltered.length,
            total_rules: grouped.length,
            limit_hit: rows.length >= limit,
            rules: grouped,
          }),
        ],
      };
    }
  );

  server.tool(
    "get_recommendation_rule",
    [
      "Fetch one recommendation rule with ALL its currently-active affected items (no item limit).",
      "Use after get_recommendations identifies a rule you want to drill into — e.g. to enumerate every vendor missing a description.",
      "Note: per-day history is not stored; this returns current state plus first_seen_at/last_seen_at per item, which approximates how long each match has persisted.",
    ].join(" "),
    {
      rule_slug: z
        .string()
        .describe(
          "Rule key (e.g. 'vendors_no_description', 'cannibalization_detection'). See get_recommendations output."
        ),
      status: z
        .enum(["active", "snoozed", "resolved"])
        .optional()
        .default("active")
        .describe("Which item bucket to return."),
    },
    async (params) => {
      const { rule_slug, status } = params;

      // First confirm the rule exists, so an unknown slug returns a clean
      // 'unknown_rule' rather than an empty rules: [] which is ambiguous.
      const ruleMeta = await db
        .select({
          id: recommendationRules.id,
          ruleKey: recommendationRules.ruleKey,
          title: recommendationRules.title,
          rationaleTemplate: recommendationRules.rationaleTemplate,
          severity: recommendationRules.severity,
          category: recommendationRules.category,
          enabled: recommendationRules.enabled,
          totalMatchCount: recommendationRules.totalMatchCount,
          lastScannedAt: recommendationRules.lastScannedAt,
          lastScanError: recommendationRules.lastScanError,
        })
        .from(recommendationRules)
        .where(eq(recommendationRules.ruleKey, rule_slug))
        .limit(1);

      if (ruleMeta.length === 0) {
        return {
          content: [
            jsonContent({
              error: "unknown_rule",
              rule_slug,
              hint: "Call get_recommendations with no filter to see registered rule_slugs.",
            }),
          ],
          isError: true,
        };
      }

      const rows = await fetchRecommendationsRaw(db, {
        status,
        ruleSlug: rule_slug,
        limit: 500, // Practical ceiling; D1 SELECT is fast at this size.
      });

      const labels = await loadEntityLabels(db, rows);
      const items = rows.map((r) => shapeItem(r, labels));

      const m = ruleMeta[0];
      return {
        content: [
          jsonContent({
            rule_slug: m.ruleKey,
            title: m.title,
            rationale_template: m.rationaleTemplate,
            severity: m.severity,
            category: m.category,
            tier: tierFor(m.ruleKey),
            enabled: m.enabled,
            total_match_count: m.totalMatchCount ?? 0,
            last_scanned_at: m.lastScannedAt ? Math.floor(m.lastScannedAt.getTime() / 1000) : null,
            last_scan_error: m.lastScanError,
            status,
            affected_count: items.length,
            affected_items: items,
            history_note:
              "Per-day count history is not stored. Use first_seen_at/last_seen_at per item to estimate persistence.",
          }),
        ],
      };
    }
  );
}
