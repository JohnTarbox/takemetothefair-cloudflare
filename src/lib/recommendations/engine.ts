/**
 * Recommendations engine — runs registered rules against D1 and persists their
 * matches to recommendation_items so the admin UI can surface a stable
 * prioritized to-do list.
 *
 * Rules are registered in src/lib/recommendations/rules/index.ts. Each rule
 * defines:
 *   - ruleKey (stable identifier, used to look up the row in recommendation_rules)
 *   - title, severity, rationaleTemplate (display metadata, ensured-into-DB on scan)
 *   - run(db) → ItemMatch[]   (the SQL query, returning target_id + payload)
 *
 * Scan flow:
 *   1. ensureRulesRegistered() upserts each rule's display metadata (cheap, idempotent)
 *   2. For each enabled rule, run() returns current matches
 *   3. Per match: INSERT ... ON CONFLICT (rule_id, target_id) DO UPDATE last_seen_at
 *   4. Items that no longer match are simply not touched; the active-list query's
 *      `last_seen_at > now - 7d` filter auto-resolves them out of view.
 *
 * Active list filter:
 *   - last_seen_at > now - 7d (fresh)
 *   - acted_at IS NULL (not yet acted)
 *   - dismissed_until IS NULL OR dismissed_until < now (snooze expired)
 */

import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { recommendationItems, recommendationRules } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export type Severity = "red" | "yellow" | "blue";

export type ItemMatch = {
  // Stable identifier within the rule's domain (vendor.id, event.id, query string, etc.)
  // Use null for rules that produce a single global item ("system needs attention").
  targetId: string | null;
  targetType: string;
  // Arbitrary JSON payload for rule-specific render data (vendor name, event slug,
  // query text, etc.). Stored as JSON string in the DB.
  payload?: Record<string, unknown>;
};

export interface RuleDefinition {
  ruleKey: string;
  title: string;
  rationaleTemplate: string;
  severity: Severity;
  category?: string;
  run(db: Db): Promise<ItemMatch[]>;
}

export type ActiveItem = {
  itemId: string;
  ruleId: string;
  ruleKey: string;
  title: string;
  rationaleTemplate: string;
  severity: Severity;
  category: string | null;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ScanResult = {
  scannedRules: number;
  inserted: number;
  refreshed: number;
  perRule: Array<{ ruleKey: string; matched: number; inserted: number; refreshed: number }>;
};

const ACTIVE_WINDOW_SECONDS = 7 * 86400;

async function ensureRulesRegistered(db: Db, defs: RuleDefinition[]): Promise<Map<string, string>> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db.select().from(recommendationRules);
  const byKey = new Map<string, string>();
  for (const r of existing) byKey.set(r.ruleKey, r.id);

  for (const def of defs) {
    const id = byKey.get(def.ruleKey);
    if (id) {
      // Refresh display metadata so code-side edits propagate without manual SQL.
      await db
        .update(recommendationRules)
        .set({
          title: def.title,
          rationaleTemplate: def.rationaleTemplate,
          severity: def.severity,
          category: def.category ?? null,
        })
        .where(eq(recommendationRules.id, id));
    } else {
      const newId = crypto.randomUUID();
      await db.insert(recommendationRules).values({
        id: newId,
        ruleKey: def.ruleKey,
        title: def.title,
        rationaleTemplate: def.rationaleTemplate,
        severity: def.severity,
        category: def.category ?? null,
        enabled: true,
        createdAt: now,
      });
      byKey.set(def.ruleKey, newId);
    }
  }
  return byKey;
}

export async function scanAll(db: Db, defs: RuleDefinition[]): Promise<ScanResult> {
  const ruleIds = await ensureRulesRegistered(db, defs);
  const enabled = await db
    .select()
    .from(recommendationRules)
    .where(eq(recommendationRules.enabled, true));
  const enabledKeys = new Set(enabled.map((r) => r.ruleKey));
  const now = Math.floor(Date.now() / 1000);

  let totalInserted = 0;
  let totalRefreshed = 0;
  const perRule: ScanResult["perRule"] = [];

  for (const def of defs) {
    if (!enabledKeys.has(def.ruleKey)) continue;
    const ruleId = ruleIds.get(def.ruleKey);
    if (!ruleId) continue;

    const matches = await def.run(db);
    let inserted = 0;
    let refreshed = 0;

    // Pull existing items for this rule so we can decide insert vs update without
    // relying on D1's UPSERT semantics (which would also clobber dismissed_until).
    const existing = await db
      .select({ id: recommendationItems.id, targetId: recommendationItems.targetId })
      .from(recommendationItems)
      .where(eq(recommendationItems.ruleId, ruleId));
    const existingByTarget = new Map<string, string>();
    for (const e of existing) {
      existingByTarget.set(e.targetId ?? "", e.id);
    }

    for (const m of matches) {
      const key = m.targetId ?? "";
      const existingId = existingByTarget.get(key);
      const payloadJson = m.payload ? JSON.stringify(m.payload) : null;
      if (existingId) {
        await db
          .update(recommendationItems)
          .set({ lastSeenAt: now, payloadJson })
          .where(eq(recommendationItems.id, existingId));
        refreshed++;
      } else {
        await db.insert(recommendationItems).values({
          id: crypto.randomUUID(),
          ruleId,
          targetType: m.targetType,
          targetId: m.targetId,
          payloadJson,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        inserted++;
      }
    }

    perRule.push({ ruleKey: def.ruleKey, matched: matches.length, inserted, refreshed });
    totalInserted += inserted;
    totalRefreshed += refreshed;
  }

  return {
    scannedRules: perRule.length,
    inserted: totalInserted,
    refreshed: totalRefreshed,
    perRule,
  };
}

export async function getActiveItems(db: Db): Promise<ActiveItem[]> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - ACTIVE_WINDOW_SECONDS;

  const rows = await db
    .select({
      itemId: recommendationItems.id,
      ruleId: recommendationRules.id,
      ruleKey: recommendationRules.ruleKey,
      title: recommendationRules.title,
      rationaleTemplate: recommendationRules.rationaleTemplate,
      severity: recommendationRules.severity,
      category: recommendationRules.category,
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
    .where(
      and(
        gte(recommendationItems.lastSeenAt, cutoff),
        isNull(recommendationItems.actedAt),
        or(
          isNull(recommendationItems.dismissedUntil),
          sql`${recommendationItems.dismissedUntil} < ${now}`
        ),
        eq(recommendationRules.enabled, true)
      )
    );

  return rows.map((r) => {
    let payload: Record<string, unknown> | null = null;
    if (r.payloadJson) {
      try {
        payload = JSON.parse(r.payloadJson) as Record<string, unknown>;
      } catch {
        payload = null;
      }
    }
    return {
      itemId: r.itemId,
      ruleId: r.ruleId,
      ruleKey: r.ruleKey,
      title: r.title,
      rationaleTemplate: r.rationaleTemplate,
      severity: r.severity as Severity,
      category: r.category,
      targetType: r.targetType,
      targetId: r.targetId,
      payload,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    };
  });
}

export async function dismissItem(
  db: Db,
  itemId: string,
  opts: { days: number | null; reason?: string }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // days === null => snooze forever (use a far-future sentinel so the active-list
  // filter still applies cleanly without special-casing NULL).
  const dismissedUntil = opts.days === null ? null : now + opts.days * 86400;
  await db
    .update(recommendationItems)
    .set({
      dismissedAt: now,
      dismissedUntil: opts.days === null ? Number.MAX_SAFE_INTEGER : dismissedUntil,
      dismissedReason: opts.reason ?? null,
    })
    .where(eq(recommendationItems.id, itemId));
}

export async function markActed(db: Db, itemId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(recommendationItems)
    .set({ actedAt: now })
    .where(eq(recommendationItems.id, itemId));
}
