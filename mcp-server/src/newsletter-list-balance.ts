/**
 * OPE-510 scope 3 — the canary.
 *
 * Two counts that must be equal, and were not compared by anything for eleven
 * days:
 *
 *   confirmed, not unsubscribed          (newsletter_subscribers)
 *   on at least one active list          (newsletter_list_subscriptions)
 *
 * The weekend broadcast reads the second. The signup path wrote only the first.
 * So the gap between them IS the set of people who double-opted-in and receive
 * nothing — 6 before the 2026-08-21 backfill, 0 after it, and 3 again two days
 * later, because the backfill was remediation and the writer was still unwired.
 *
 * Lives in the MCP Worker rather than beside the main app's writer because this
 * is the READ side: the check has to be able to catch a writer that is broken,
 * which means not sharing the writer's code. Same query, stated in SQL, so a
 * drizzle-level mistake in the writer cannot hide here too.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db.js";

export interface NewsletterListBalance {
  confirmed_active: number;
  on_any_list: number;
  /** The actionable figure: people receiving nothing. Should be 0. */
  orphaned: number;
  balanced: boolean;
}

export async function listBalance(db: Db): Promise<NewsletterListBalance> {
  const [row] = await db
    .select({
      confirmedActive: sql<number>`(
        SELECT COUNT(*) FROM newsletter_subscribers
         WHERE confirmed = 1 AND unsubscribed = 0)`,
      onAnyList: sql<number>`(
        SELECT COUNT(DISTINCT subscriber_id) FROM newsletter_list_subscriptions
         WHERE unsubscribed_at IS NULL)`,
      // NOT EXISTS rather than NOT IN: `subscriber_id` is nullable in principle,
      // and a single NULL turns NOT IN into a filter that matches nothing —
      // which would report a clean zero on a table full of orphans.
      orphaned: sql<number>`(
        SELECT COUNT(*) FROM newsletter_subscribers s
         WHERE s.confirmed = 1 AND s.unsubscribed = 0
           AND NOT EXISTS (
             SELECT 1 FROM newsletter_list_subscriptions l
              WHERE l.subscriber_id = s.id AND l.unsubscribed_at IS NULL))`,
    })
    .from(sql`(SELECT 1) AS one`);

  const confirmedActive = Number(row?.confirmedActive ?? 0);
  const onAnyList = Number(row?.onAnyList ?? 0);
  const orphaned = Number(row?.orphaned ?? 0);
  return {
    confirmed_active: confirmedActive,
    on_any_list: onAnyList,
    orphaned,
    balanced: orphaned === 0,
  };
}
