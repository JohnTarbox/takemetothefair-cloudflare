/**
 * OPE-1617 — scheduled feed polling.
 *
 * Hourly, reads every ENABLED feed whose `next_read_at` has come (or that has
 * never been read), oldest-due first, at most `limit` per run, through the same
 * `runFeedRead` an operator's manual read uses. Each feed then sets its own next
 * time: its interval (default 6h) after a good read or a 304, a doubling backoff
 * after errors.
 *
 * GATED: does nothing unless `FEED_POLLING_ENABLED = "true"` on the MCP Worker.
 * It ships "false". A scheduled read WRITES (feed items, organizer_feed
 * discrepancies, pin releases) though it sends nothing — every question still
 * goes out only as an operator draft John approves. Turning it on is John's
 * call, and it is pointless before a feed is registered.
 *
 * Evidence: each real read writes `feed.ingested` to admin_actions, which the
 * dormant `organizer-feed-ingest` heartbeat probe (0406) reads. Each run also
 * writes one `info` row under FEED_POLL_SOURCE, flag off or on, so "the cron
 * fired and the flag was off" is visible rather than silent.
 */
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { promoterEventFeeds } from "../schema.js";
import { getDb, type Db } from "../db.js";
import { logError } from "../logger.js";
import { runFeedRead } from "./run.js";

export const FEED_POLL_SOURCE = "feeds:scheduled-poll";
const DEFAULT_LIMIT = 10;

export interface FeedPollSummary {
  enabled: boolean;
  due: number;
  ingested: number;
  not_modified: number;
  errors: number;
  feed_ids: string[];
}

export async function pollDueFeeds(
  db: Db,
  args: { now: Date; enabled: boolean; limit?: number; fetchImpl?: typeof fetch }
): Promise<FeedPollSummary> {
  const summary: FeedPollSummary = {
    enabled: args.enabled,
    due: 0,
    ingested: 0,
    not_modified: 0,
    errors: 0,
    feed_ids: [],
  };
  if (!args.enabled) return summary;
  const due = await db
    .select({ id: promoterEventFeeds.id })
    .from(promoterEventFeeds)
    .where(
      and(
        eq(promoterEventFeeds.enabled, true),
        or(isNull(promoterEventFeeds.nextReadAt), lte(promoterEventFeeds.nextReadAt, args.now))
      )
    )
    .orderBy(asc(promoterEventFeeds.nextReadAt))
    .limit(args.limit ?? DEFAULT_LIMIT);
  summary.due = due.length;
  for (const f of due) {
    summary.feed_ids.push(f.id);
    // One feed's failure is recorded on that feed (backoff) and never stops the rest.
    try {
      const r = await runFeedRead(db, {
        feedId: f.id,
        now: args.now,
        dryRun: false,
        actor: "system:feed-poll",
        fetchImpl: args.fetchImpl,
      });
      if (r.outcome === "ingested") summary.ingested++;
      else if (r.outcome === "not_modified") summary.not_modified++;
      else summary.errors++;
    } catch {
      summary.errors++;
    }
  }
  return summary;
}

export async function runScheduledFeedPoll(env: {
  DB: D1Database;
  FEED_POLLING_ENABLED?: string;
}): Promise<void> {
  const s = await pollDueFeeds(getDb(env.DB), {
    now: new Date(),
    enabled: env.FEED_POLLING_ENABLED === "true",
  });
  await logError(env.DB, {
    level: "info",
    source: FEED_POLL_SOURCE,
    message: s.enabled
      ? `feed poll: due ${s.due}, ingested ${s.ingested}, not modified ${s.not_modified}, errors ${s.errors}`
      : "feed poll: FEED_POLLING_ENABLED is not true; read nothing",
  });
}
