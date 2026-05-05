// Recommendation items that have been snoozed for >30 days without being
// acted on. Per §10.4 of the doc, the "memory_rule_open_status" intent is
// to keep operator attention on items that are perpetually deferred — if
// something has been snoozed multiple times without resolution, surface it
// as its own meta-recommendation so it doesn't get lost.
//
// Implementation note: the doc framed this as "memory-rule items not yet
// converted to engineering tickets" — reading literally, that would require
// scanning ~/.claude/projects/.../memory/*.md from edge runtime, which the
// runtime doesn't allow (no fs access). The semantic equivalent here is
// "snoozed-without-action items in the recommendations queue" which the
// engine already tracks. Same operator intent, runtime-feasible.

import { and, isNotNull, lt, sql } from "drizzle-orm";
import { recommendationItems, recommendationRules } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const STALE_DAYS = 30;

export const longSnoozedItemsRule: RuleDefinition = {
  ruleKey: "long_snoozed_items",
  title: "Recommendation items snoozed for 30+ days without action",
  rationaleTemplate:
    "{n} items in the recommendations queue have been snoozed for 30+ days without being acted on. Either the underlying issue resolved itself (act it; it'll re-emerge if it returns), or the operator has been deferring something that needs a real decision. Don't let items rot in snooze.",
  severity: "blue",
  category: "process",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const cutoff = new Date(Date.now() - STALE_DAYS * 86400_000);

    const rows = await db
      .select({
        itemId: recommendationItems.id,
        ruleId: recommendationItems.ruleId,
        ruleKey: recommendationRules.ruleKey,
        ruleTitle: recommendationRules.title,
        targetType: recommendationItems.targetType,
        targetId: recommendationItems.targetId,
        firstSeenAt: recommendationItems.firstSeenAt,
        dismissedUntil: recommendationItems.dismissedUntil,
      })
      .from(recommendationItems)
      .innerJoin(
        recommendationRules,
        sql`${recommendationItems.ruleId} = ${recommendationRules.id}`
      )
      .where(
        and(
          isNotNull(recommendationItems.dismissedUntil),
          lt(recommendationItems.firstSeenAt, cutoff),
          // Don't include this rule itself (avoid recursion)
          sql`${recommendationRules.ruleKey} != 'long_snoozed_items'`
        )
      )
      .limit(200);

    return rows.map((r) => ({
      // Stable per-snoozed-item; if the underlying item resolves and the
      // operator unsnoozes, it drops out on the next scan (autoResolve).
      targetType: "recommendation_item",
      targetId: r.itemId,
      payload: {
        sourceRuleKey: r.ruleKey,
        sourceRuleTitle: r.ruleTitle,
        sourceTargetType: r.targetType,
        sourceTargetId: r.targetId,
        firstSeenAt: r.firstSeenAt?.toISOString() ?? null,
        snoozedUntil: r.dismissedUntil?.toISOString() ?? null,
      },
    }));
  },
};
