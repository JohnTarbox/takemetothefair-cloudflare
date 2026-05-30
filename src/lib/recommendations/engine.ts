/**
 * Recommendations engine — runs registered rules against D1 and persists their
 * matches to recommendation_items so the admin UI can surface a stable
 * prioritized to-do list.
 *
 * Rules are registered in src/lib/recommendations/rules/index.ts. Each rule
 * defines:
 *   - ruleKey (stable identifier, used to look up the row in recommendation_rules)
 *   - title, severity, rationaleTemplate (display metadata, ensured-into-DB on scan)
 *   - run(db) → ItemMatch[]   (returns ALL current matches; engine handles
 *     storage and resolution. Rules used to LIMIT to 25 internally; that's
 *     gone — see "auto-resolve" below.)
 *   - autoResolve?: boolean   (DB-backed rules set true; the engine treats
 *     run()'s output as the complete current match set and resolves stale
 *     items. External-fetch rules — GSC API, static-page scrapers — leave
 *     this false because an empty result set might mean "fetch failed" rather
 *     than "all resolved.")
 *
 * Scan flow:
 *   1. ensureRulesRegistered() upserts each rule's display metadata (cheap, idempotent)
 *   2. For each enabled rule, run() returns ALL current matches
 *   3. Per match: refresh existing item (last_seen_at + payload_json) or insert new
 *   4. If autoResolve: items in DB but NOT in current match set are marked
 *      acted (resolved), so they drop out of the active list immediately —
 *      no longer wait for the 7-day decay window.
 *   5. recommendation_rules.total_match_count + last_scanned_at are written
 *      so the admin UI can show "Showing N of M" when items are dismissed.
 *
 * Active list filter:
 *   - last_seen_at > now - 7d (fresh; safety net for non-autoResolve rules)
 *   - acted_at IS NULL (not yet acted; auto-resolved items drop out here)
 *   - dismissed_until IS NULL OR dismissed_until < now (snooze expired)
 */

import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { errorLogs, recommendationItems, recommendationRules } from "@/lib/db/schema";
import { buildCanonicalPathChecker, type CanonicalPathChecker } from "./canonical-paths";

// GSC-derived rules whose payload.topPagePath can point at a renamed slug.
// Other rules (cannibalization included — its hubPath is always a hub URL by
// construction, and its entityPath is derived from a live entity.slug) don't
// need the filter.
const PATH_FILTERED_RULES = new Set(["low_ctr_pages", "seo_position_11_20"]);

type StalePathDrops = Map<string, { count: number; samplePaths: string[] }>;

function filterStalePathMatches(
  ruleKey: string,
  matches: ItemMatch[],
  checker: CanonicalPathChecker,
  acc: StalePathDrops
): ItemMatch[] {
  if (!PATH_FILTERED_RULES.has(ruleKey)) return matches;
  const kept: ItemMatch[] = [];
  for (const m of matches) {
    const path = typeof m.payload?.topPagePath === "string" ? m.payload.topPagePath : null;
    if (path && checker.classifyPath(path) === "stale") {
      const entry = acc.get(ruleKey) ?? { count: 0, samplePaths: [] };
      entry.count++;
      if (entry.samplePaths.length < 5) entry.samplePaths.push(path);
      acc.set(ruleKey, entry);
      continue;
    }
    kept.push(m);
  }
  return kept;
}

/**
 * One-pass sweep of existing active recommendation_items whose
 * payload.topPagePath now points at a stale slug. Marks them acted so
 * they drop out of the active queue, same as autoResolve would have
 * done if the rules supported it.
 *
 * Why this is needed in addition to filterStalePathMatches: the GSC-
 * derived rules (low_ctr_pages, seo_position_11_20) deliberately omit
 * `autoResolve: true` so a transient GSC API failure returning []
 * doesn't clobber the active list. That same omission means items
 * inserted before the path-filter shipped (or before a slug rename)
 * sit in the active queue forever, since no future scan re-inserts
 * them (the filter blocks the re-insert) and nothing resolves them.
 *
 * The sweep runs once per scanAll and is bounded by the number of
 * active items for path-filtered rules (low tens to low hundreds in
 * practice). One UPDATE per rule via inArray; cheap.
 */
/**
 * Pure helper: pull the `topPagePath` field out of a stored payload JSON
 * string, returning null on any failure mode (missing, malformed, wrong
 * type). Exported for unit testing — exercised by the sweep below.
 */
export function extractTopPagePath(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { topPagePath?: unknown };
    return typeof parsed.topPagePath === "string" ? parsed.topPagePath : null;
  } catch {
    return null;
  }
}

async function sweepExistingStalePathItems(
  db: Db,
  checker: CanonicalPathChecker,
  ruleIdsByKey: Map<string, string>,
  now: Date,
  acc: StalePathDrops
): Promise<void> {
  for (const ruleKey of PATH_FILTERED_RULES) {
    const ruleId = ruleIdsByKey.get(ruleKey);
    if (!ruleId) continue;
    const existing = await db
      .select({
        id: recommendationItems.id,
        payloadJson: recommendationItems.payloadJson,
      })
      .from(recommendationItems)
      .where(and(eq(recommendationItems.ruleId, ruleId), isNull(recommendationItems.actedAt)));
    const staleIds: string[] = [];
    for (const row of existing) {
      const path = extractTopPagePath(row.payloadJson);
      if (!path) continue;
      if (checker.classifyPath(path) !== "stale") continue;
      staleIds.push(row.id);
      const entry = acc.get(ruleKey) ?? { count: 0, samplePaths: [] };
      entry.count++;
      if (entry.samplePaths.length < 5) entry.samplePaths.push(path);
      acc.set(ruleKey, entry);
    }
    if (staleIds.length === 0) continue;
    await db
      .update(recommendationItems)
      .set({ actedAt: now })
      .where(inArray(recommendationItems.id, staleIds));
  }
}

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
  // When true, run()'s matches are treated as the complete current state:
  // existing items not in this set get auto-resolved (acted_at = now). Set on
  // DB-backed rules where SELECT-with-predicate is authoritative. Leave false
  // (default) for external-fetch rules so a transient API failure returning
  // [] doesn't clobber the active list.
  autoResolve?: boolean;
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
  // Total matches for this rule from the most recent scan (unbounded — not
  // affected by dismissals). Denormalized onto each row for convenience; the
  // UI groups items by rule and reads this once per group.
  ruleTotalMatchCount: number;
  /** Per-rule scan-freshness timestamp denormalized from
   *  recommendation_rules.last_scanned_at. The rule-card UI uses this to
   *  badge stale-data rules (>24h since their last successful scan) so
   *  the operator doesn't act on silently-truncated data. Null when the
   *  rule has never completed a scan. Per `feedback_ms_seconds_divergence_*`
   *  Drizzle returns this as a real Date because the column uses
   *  mode:"timestamp" (seconds-epoch). */
  ruleLastScannedAt: Date | null;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export type ScanResult = {
  scannedRules: number;
  inserted: number;
  refreshed: number;
  resolved: number;
  /** Count of rules whose run() threw — scan kept going for the others. */
  failedRules: number;
  perRule: Array<{
    ruleKey: string;
    matched: number;
    inserted: number;
    refreshed: number;
    resolved: number;
    /** Set when this rule's run() threw. Other rules in the same scan are
     *  unaffected (engine catches per-rule). lastScannedAt is NOT updated
     *  on the failed rule so the previous timestamp is preserved as a
     *  staleness signal in the admin UI. */
    error?: string;
  }>;
};

const ACTIVE_WINDOW_MS = 7 * 86400 * 1000;

/** Max wall-clock time a single rule's run() may take before scanAll
 *  abandons it and continues to the next rule. Set well below the
 *  Cloudflare edge runtime's 30s response cap so even a chunk-of-1
 *  request can't burn the whole budget on one rule. Specifically tuned
 *  for HTTP-fetching rules (hijacked_domain_detection,
 *  cannibalization_detection, etc.) — they typically complete in
 *  3-6s but occasional slow upstreams have pushed past 20s, taking
 *  the rest of the chunk down with them. */
const PER_RULE_TIMEOUT_MS = 12_000;

/** Wraps a promise in a race against a timer. Resolves with the
 *  promise's value if it completes in time; rejects with a Timeout
 *  error otherwise. The wrapped promise keeps running in the
 *  background (we can't cancel a Drizzle query mid-flight) but the
 *  scan loop moves on. Acceptable cost: a stuck rule won't block
 *  later rules, even if its query never returns. */
export async function runWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`rule '${label}' exceeded ${ms}ms timeout`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureRulesRegistered(db: Db, defs: RuleDefinition[]): Promise<Map<string, string>> {
  const now = new Date();
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
  const now = new Date();

  const pathChecker = await buildCanonicalPathChecker(db);
  const stalePathDrops: StalePathDrops = new Map(); // new matches blocked at filter
  const staleSweepDrops: StalePathDrops = new Map(); // existing items resolved by sweep

  let totalInserted = 0;
  let totalRefreshed = 0;
  let totalResolved = 0;
  let failedRules = 0;
  const perRule: ScanResult["perRule"] = [];

  for (const def of defs) {
    if (!enabledKeys.has(def.ruleKey)) continue;
    const ruleId = ruleIds.get(def.ruleKey);
    if (!ruleId) continue;

    // Per-rule isolation: one rule's failure must not kill the scan for
    // every later rule. Daily cron + manual "Run scan" were both losing
    // ~21 rules of work because a single failing rule mid-list threw out
    // of the loop (incident 2026-05-13 — see commit message).
    try {
      const rawMatches = filterStalePathMatches(
        def.ruleKey,
        await runWithTimeout(def.run(db), PER_RULE_TIMEOUT_MS, def.ruleKey),
        pathChecker,
        stalePathDrops
      );

      // Dedupe matches by targetId before processing. A rule that emits
      // the same targetId twice (or null-targetId twice — the engine
      // treats null as a single global slot per rule) would trip the
      // UNIQUE constraint on (rule_id, target_id) when we INSERT the
      // second occurrence, killing the whole rule for this scan even
      // though the first occurrence INSERTed fine. Defense-in-depth
      // for the event_date_drift case (2026-05-19 incident — the rule's
      // SELECT JOINs an event-findings table where the same event can
      // have multiple unresolved finding rows) but also any future rule
      // that accidentally emits duplicates. The rule-level fix is still
      // required (it preserves which finding wins); this is the safety
      // net so the symptom never reaches D1.
      const seenTargetIds = new Set<string>();
      const matches: typeof rawMatches = [];
      let droppedDupes = 0;
      for (const m of rawMatches) {
        const key = m.targetId ?? "__null__";
        if (seenTargetIds.has(key)) {
          droppedDupes++;
          continue;
        }
        seenTargetIds.add(key);
        matches.push(m);
      }
      if (droppedDupes > 0) {
        // Loud-but-non-fatal: surface in Pages logs so the responsible
        // rule shows up in audits without breaking the scan.
        console.warn(
          `[recommendations.scanAll] rule "${def.ruleKey}" emitted ${droppedDupes} duplicate targetId(s); dropped before INSERT. Fix the rule's run().`
        );
      }

      let inserted = 0;
      let refreshed = 0;
      let resolved = 0;

      // Pull existing items for this rule so we can decide insert vs update vs
      // resolve without relying on D1's UPSERT semantics (which would clobber
      // dismissed_until).
      const existing = await db
        .select({
          id: recommendationItems.id,
          targetId: recommendationItems.targetId,
          actedAt: recommendationItems.actedAt,
        })
        .from(recommendationItems)
        .where(eq(recommendationItems.ruleId, ruleId));
      const existingByTarget = new Map<string, { id: string; actedAt: Date | null }>();
      for (const e of existing) {
        existingByTarget.set(e.targetId ?? "", { id: e.id, actedAt: e.actedAt });
      }

      const matchedTargets = new Set<string>();
      for (const m of matches) {
        const key = m.targetId ?? "";
        matchedTargets.add(key);
        const existingRow = existingByTarget.get(key);
        const payloadJson = m.payload ? JSON.stringify(m.payload) : null;
        if (existingRow) {
          // Refresh: bump last_seen_at + payload. Don't clear acted_at — both
          // manual "Mark done" and prior auto-resolve set it, and we can't tell
          // them apart. Manually-acted items should stay terminal: admin said
          // they handled it, even if the entity is technically still matching.
          // If admin wants the rule to re-surface, they delete or undo the row
          // (or wait for the entity to leave + re-enter the match set, which
          // creates a brand-new item).
          await db
            .update(recommendationItems)
            .set({ lastSeenAt: now, payloadJson })
            .where(eq(recommendationItems.id, existingRow.id));
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

      // Auto-resolve: existing items whose target_id is no longer in the current
      // match set get marked acted, so they drop out of the active list. Skipped
      // for rules where the match set might be empty due to fetch failure (see
      // RuleDefinition.autoResolve docs).
      if (def.autoResolve) {
        for (const [targetId, existingRow] of existingByTarget.entries()) {
          if (matchedTargets.has(targetId)) continue;
          if (existingRow.actedAt) continue; // already resolved/acted; skip
          await db
            .update(recommendationItems)
            .set({ actedAt: now })
            .where(eq(recommendationItems.id, existingRow.id));
          resolved++;
        }
      }

      // Record total + last-scan for the "Showing N of M" UI label. Clear
      // lastScanError so a previously-failing rule that's now succeeding
      // stops surfacing its stale error banner in the admin UI.
      await db
        .update(recommendationRules)
        .set({ totalMatchCount: matches.length, lastScannedAt: now, lastScanError: null })
        .where(eq(recommendationRules.id, ruleId));

      perRule.push({
        ruleKey: def.ruleKey,
        matched: matches.length,
        inserted,
        refreshed,
        resolved,
      });
      totalInserted += inserted;
      totalRefreshed += refreshed;
      totalResolved += resolved;
    } catch (err) {
      // Log + persist + continue. Don't update last_scanned_at on the failed
      // rule — its row keeps the prior timestamp so the admin UI can show
      // staleness ("last successful scan was N days ago") and operators can
      // spot which rules are silently broken.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[recommendations.scanAll] rule "${def.ruleKey}" failed:`, message);
      // Persist the message onto recommendation_rules so the admin tab can
      // surface a red banner without operators having to tail Pages logs.
      // Truncate to keep the column reasonable; full message is in logs.
      await db
        .update(recommendationRules)
        .set({ lastScanError: message.slice(0, 2000) })
        .where(eq(recommendationRules.id, ruleId));
      perRule.push({
        ruleKey: def.ruleKey,
        matched: 0,
        inserted: 0,
        refreshed: 0,
        resolved: 0,
        error: message,
      });
      failedRules++;
    }
  }

  // Sweep existing active items whose topPagePath is now stale. Targets
  // the gap that filterStalePathMatches doesn't cover: items inserted
  // before the filter shipped (or before a slug rename) that linger
  // because the GSC-derived rules don't autoResolve. Adds resolved count
  // to totalResolved so the scan-result tally reflects the cleanup.
  await sweepExistingStalePathItems(db, pathChecker, ruleIds, now, staleSweepDrops);
  let sweptTotal = 0;
  for (const v of staleSweepDrops.values()) sweptTotal += v.count;
  totalResolved += sweptTotal;

  if (stalePathDrops.size > 0) {
    let totalFiltered = 0;
    const byRule: Record<string, { count: number; samplePaths: string[] }> = {};
    for (const [k, v] of stalePathDrops) {
      byRule[k] = v;
      totalFiltered += v.count;
    }
    await db.insert(errorLogs).values({
      id: crypto.randomUUID(),
      timestamp: now,
      level: "info",
      source: "gsc-recommendations:stale-slug",
      message: `Filtered ${totalFiltered} stale topPagePath items from recommendations scan`,
      context: JSON.stringify({ totalFiltered, byRule }),
    });
  }

  if (staleSweepDrops.size > 0) {
    const byRule: Record<string, { count: number; samplePaths: string[] }> = {};
    for (const [k, v] of staleSweepDrops) byRule[k] = v;
    await db.insert(errorLogs).values({
      id: crypto.randomUUID(),
      timestamp: now,
      level: "info",
      source: "gsc-recommendations:stale-slug",
      message: `Swept ${sweptTotal} existing stale-path items from active queue`,
      context: JSON.stringify({ totalSwept: sweptTotal, byRule }),
    });
  }

  return {
    scannedRules: perRule.length,
    inserted: totalInserted,
    refreshed: totalRefreshed,
    resolved: totalResolved,
    failedRules,
    perRule,
  };
}

export async function getActiveItems(db: Db): Promise<ActiveItem[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);

  const rows = await db
    .select({
      itemId: recommendationItems.id,
      ruleId: recommendationRules.id,
      ruleKey: recommendationRules.ruleKey,
      title: recommendationRules.title,
      rationaleTemplate: recommendationRules.rationaleTemplate,
      severity: recommendationRules.severity,
      category: recommendationRules.category,
      totalMatchCount: recommendationRules.totalMatchCount,
      ruleLastScannedAt: recommendationRules.lastScannedAt,
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
          // dismissed_until is seconds-epoch (Drizzle mode:"timestamp" stores
          // Math.floor(date.getTime()/1000) — see
          // reference_drizzle_timestamp_mode_is_seconds memory). Compare in
          // the same unit. Earlier this used now.getTime() (ms) and the
          // filter `seconds < ms` was always true, which silently masked any
          // active snooze when no acted_at was also set. The "snooze
          // forever" sentinel uses a far-future Date so this check still
          // cleanly filters it out.
          sql`${recommendationItems.dismissedUntil} < ${Math.floor(now.getTime() / 1000)}`
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
      ruleTotalMatchCount: r.totalMatchCount ?? 0,
      ruleLastScannedAt: r.ruleLastScannedAt,
      targetType: r.targetType,
      targetId: r.targetId,
      payload,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    };
  });
}

/**
 * Per-rule "open count as of N days ago" — drives the WoW trend column on
 * the Recommendations tab (analyst Item 10 split, 2026-05-30).
 *
 * An item is considered "open at asOf" if:
 *   - firstSeenAt <= asOf (existed at the cutoff), AND
 *   - (actedAt IS NULL OR actedAt > asOf) — still unresolved at the cutoff
 *
 * Dismissals are NOT excluded here: a snoozed item still counts as an open
 * problem from the operator's perspective; the trend tells you whether the
 * underlying issue queue is shrinking or growing, regardless of UI hides.
 *
 * Returns a Map keyed by ruleId. Rules with zero open items at asOf are
 * absent from the map (caller treats absence as 0).
 *
 * Cheap: one SQL with COUNT(*) GROUP BY rule_id and an indexed range on
 * firstSeenAt. No new schema.
 */
export async function getOpenMatchCountsAsOf(db: Db, asOf: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({
      ruleId: recommendationItems.ruleId,
      n: sql<number>`COUNT(*)`,
    })
    .from(recommendationItems)
    .where(
      and(
        lte(recommendationItems.firstSeenAt, asOf),
        or(
          isNull(recommendationItems.actedAt),
          sql`${recommendationItems.actedAt} > ${Math.floor(asOf.getTime() / 1000)}`
        )
      )
    )
    .groupBy(recommendationItems.ruleId);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.ruleId, Number(r.n));
  return out;
}

// Snooze-forever sentinel: a date far past anything we'd see in practice but
// well within the safe Date range. Picked deliberately to land in the year
// 9999 so the active-list filter (dismissedUntil < now) cleanly excludes it.
const SNOOZE_FOREVER_DATE = new Date(8640000000000000); // ~year 275760, max valid Date

export async function dismissItem(
  db: Db,
  itemId: string,
  opts: { days: number | null; reason?: string }
): Promise<void> {
  const now = new Date();
  const dismissedUntil =
    opts.days === null ? SNOOZE_FOREVER_DATE : new Date(now.getTime() + opts.days * 86400 * 1000);
  await db
    .update(recommendationItems)
    .set({
      dismissedAt: now,
      dismissedUntil,
      dismissedReason: opts.reason ?? null,
    })
    .where(eq(recommendationItems.id, itemId));
}

export async function markActed(db: Db, itemId: string): Promise<void> {
  await db
    .update(recommendationItems)
    .set({ actedAt: new Date() })
    .where(eq(recommendationItems.id, itemId));
}

/**
 * Mark every open (not-yet-acted) recommendation item for a target as
 * acted. Used by destructive operations (delete_vendor) to clean up open
 * recommendations on the now-deleted entity. Returns the number of items
 * resolved.
 */
export async function markActedAllForTarget(
  db: Db,
  targetType: string,
  targetId: string
): Promise<number> {
  const open = await db
    .select({ id: recommendationItems.id })
    .from(recommendationItems)
    .where(
      and(
        eq(recommendationItems.targetType, targetType),
        eq(recommendationItems.targetId, targetId),
        isNull(recommendationItems.actedAt)
      )
    );
  if (open.length === 0) return 0;
  const now = new Date();
  for (const row of open) {
    await db
      .update(recommendationItems)
      .set({ actedAt: now })
      .where(eq(recommendationItems.id, row.id));
  }
  return open.length;
}

/**
 * Scan-state summary for the admin Recommendations tab header + per-rule
 * error banners. Returned as a single object so the page can read both
 * pieces in one round-trip.
 *
 * `lastSuccessfulScanAt` is the MAX of recommendation_rules.last_scanned_at
 * across all rules — which is the most recent time scanAll() ran and at
 * least one rule completed successfully (per-rule failures preserve their
 * prior last_scanned_at). Null when no rule has ever scanned.
 *
 * `failedRules` lists rules whose last attempted scan threw, ordered by
 * rule_key for stable rendering. Each entry includes the persisted error
 * message and the rule's frozen last_scanned_at so the banner can show
 * staleness ("last successful scan: 7d ago").
 */
export type ScanState = {
  lastSuccessfulScanAt: Date | null;
  failedRules: Array<{
    ruleId: string;
    ruleKey: string;
    title: string;
    error: string;
    lastScannedAt: Date | null;
  }>;
  /** Every enabled rule's last-scanned timestamp — including rules with
   *  zero current matches. The Recommendations panel uses this for the
   *  "Scan freshness" summary so rules that have NEVER scanned (chronic
   *  first-run timeouts before the 5/19 fix surfaced 12 of 26 in this
   *  state) are still visible. Sorted by rule_key. */
  allRules: Array<{
    ruleId: string;
    ruleKey: string;
    title: string;
    lastScannedAt: Date | null;
    hasError: boolean;
  }>;
};

export async function getScanState(db: Db): Promise<ScanState> {
  const rows = await db
    .select({
      id: recommendationRules.id,
      ruleKey: recommendationRules.ruleKey,
      title: recommendationRules.title,
      lastScannedAt: recommendationRules.lastScannedAt,
      lastScanError: recommendationRules.lastScanError,
    })
    .from(recommendationRules)
    .where(eq(recommendationRules.enabled, true));

  let lastSuccessfulScanAt: Date | null = null;
  const failedRules: ScanState["failedRules"] = [];
  const allRules: ScanState["allRules"] = [];
  for (const r of rows) {
    if (r.lastScannedAt && (!lastSuccessfulScanAt || r.lastScannedAt > lastSuccessfulScanAt)) {
      lastSuccessfulScanAt = r.lastScannedAt;
    }
    if (r.lastScanError) {
      failedRules.push({
        ruleId: r.id,
        ruleKey: r.ruleKey,
        title: r.title,
        error: r.lastScanError,
        lastScannedAt: r.lastScannedAt,
      });
    }
    allRules.push({
      ruleId: r.id,
      ruleKey: r.ruleKey,
      title: r.title,
      lastScannedAt: r.lastScannedAt,
      hasError: !!r.lastScanError,
    });
  }
  failedRules.sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));
  allRules.sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));
  return { lastSuccessfulScanAt, failedRules, allRules };
}
