/**
 * OPE-77 (CPI Move 3) — per-rule verify registry.
 *
 * The recommendations "verify loop" closes the feedback gap on acted items: when
 * an operator marks a rule's items done, we snapshot the metric that made the
 * rule match, wait `lagDays`, then re-read the metric from stored data. If it
 * improved we clear the item; if not we re-open it as an "acted, no movement"
 * learning signal (see the re-measure endpoint + decide.ts).
 *
 * ONLY rules present in this registry participate in the verify loop. Every
 * other rule is acted exactly as before — no verify columns are written and the
 * re-measure endpoint never touches them. v1 wires a single rule:
 * `page_1_zero_click_queries`. The framework supports adding more by dropping a
 * new entry here and a matching branch in decideVerifyOutcome().
 */

import { desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { gscSearchMetrics } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/**
 * SEO default lag before re-measuring. GSC + crawl data lag reality by ~1-2
 * weeks, so re-measuring sooner would read noise, not the effect of the fix.
 */
export const SEO_DEFAULT_LAG_DAYS = 14;

export interface VerifyItem {
  targetId: string | null;
  payloadJson: string | null;
}

export interface RuleVerifier {
  /** Days to wait after "acted" before the metric is re-measured. */
  lagDays: number;
  /**
   * Read the CURRENT metric for an acted item from stored data (never a live
   * external fetch — that's why the loop leans on gsc_search_metrics). Returns a
   * small JSON-able numeric object, or null if the metric can't be read yet
   * (e.g. no stored row for the query), in which case the item stays pending and
   * is retried on the next run.
   */
  readMetric(db: Db, item: VerifyItem): Promise<Record<string, number> | null>;
}

export const VERIFY_REGISTRY: Record<string, RuleVerifier> = {
  page_1_zero_click_queries: {
    lagDays: SEO_DEFAULT_LAG_DAYS,
    async readMetric(db, item) {
      // targetId is the (lowercased) GSC query string. Read the LATEST stored
      // daily row for that query — gsc_search_metrics is upserted daily, so the
      // max-date row is the freshest measurement without a live GSC call.
      if (!item.targetId) return null;
      const rows = await db
        .select({
          clicks: gscSearchMetrics.clicks,
          impressions: gscSearchMetrics.impressions,
          ctr: gscSearchMetrics.ctr,
          position: gscSearchMetrics.position,
        })
        .from(gscSearchMetrics)
        .where(eq(gscSearchMetrics.query, item.targetId))
        .orderBy(desc(gscSearchMetrics.date))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      };
    },
  },
};

/** Look up the verifier for a rule, or undefined if the rule isn't in the loop. */
export function getVerifier(ruleKey: string): RuleVerifier | undefined {
  return VERIFY_REGISTRY[ruleKey];
}
