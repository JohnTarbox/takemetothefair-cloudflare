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
 * OPE-1626 switched it on (John approved automatic, review-only reading of
 * OHTM's calendar as a pilot). A scheduled read WRITES (feed items,
 * organizer_feed discrepancies, pin releases) though it sends nothing — no
 * reader path composes a question; a batch is composed only by the operator's
 * `compose_feed_discrepancy_batch`, which a feed's `questions_hold` refuses.
 *
 * Evidence: each real read writes `feed.ingested` to admin_actions, which the
 * dormant `organizer-feed-ingest` heartbeat probe (0406) reads. Each run also
 * writes one `info` row under FEED_POLL_SOURCE, flag off or on, so "the cron
 * fired and the flag was off" is visible rather than silent.
 *
 * OPE-1621 — change pings. A ping (or a verified WebSub notification) moves a
 * feed's `next_read_at` to within 2 minutes and stamps `ping_requested_at`.
 * The hourly run would reach it eventually; the every-10-minutes PINGED pass
 * (`runScheduledPingedFeedPass`) reads only pinged, due feeds, so a ping is
 * served within about ten minutes. Same gate, same `runFeedRead`. After any
 * read of a pinged feed — good, 304 or error — the ping is settled, unless
 * another ping arrived during the read.
 *
 * WebSub (OPE-1626): subscribing POSTs to a third-party hub, which was not
 * approved with polling. A read that advertised a hub subscribes, and the
 * hourly run renews leases, only when BOTH `FEED_POLLING_ENABLED` and
 * `WEBSUB_ENABLED` are "true" (`isWebSubEnabled`). Pings — including a
 * notification on a subscription made earlier — stay gated by polling alone.
 */
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { PING_COALESCE_MS, promoterEventFeeds } from "../schema.js";
import { getDb, type Db } from "../db.js";
import { logError } from "../logger.js";
import { runFeedRead } from "./run.js";
import {
  ensureWebSubSubscription,
  isWebSubEnabled,
  renewWebSubLeases,
  type WebSubFlags,
} from "./websub.js";

export const FEED_POLL_SOURCE = "feeds:scheduled-poll";
export const FEED_PING_PASS_SOURCE = "feeds:pinged-pass";
const DEFAULT_LIMIT = 10;

export interface FeedPollSummary {
  enabled: boolean;
  due: number;
  ingested: number;
  not_modified: number;
  errors: number;
  /** OPE-1626 — a feed disabled between selection and read. */
  skipped: number;
  feed_ids: string[];
}

/**
 * A pinged feed was just read (whatever the outcome): clear its ping. A ping
 * that landed DURING the read keeps it pinged and due 2 minutes after that
 * ping, because the read may have fetched the page before the change.
 */
async function settlePing(db: Db, feedId: string, readStart: Date): Promise<void> {
  const s = Math.floor(readStart.getTime() / 1000);
  const lag = PING_COALESCE_MS / 1000;
  const f = promoterEventFeeds;
  await db
    .update(f)
    .set({
      pingRequestedAt: sql`CASE WHEN ${f.lastPingedAt} > ${s} THEN ${f.lastPingedAt} ELSE NULL END`,
      nextReadAt: sql`CASE WHEN ${f.lastPingedAt} > ${s} AND (${f.nextReadAt} IS NULL OR ${f.nextReadAt} > ${f.lastPingedAt} + ${lag}) THEN ${f.lastPingedAt} + ${lag} ELSE ${f.nextReadAt} END`,
    })
    .where(and(eq(f.id, feedId), isNotNull(f.pingRequestedAt)));
}

export async function pollDueFeeds(
  db: Db,
  args: {
    now: Date;
    enabled: boolean;
    limit?: number;
    fetchImpl?: typeof fetch;
    /** OPE-1621 — read only the feeds a ping marked due (the 10-minute pass). */
    onlyPinged?: boolean;
    /**
     * OPE-1626 — the flags WebSub needs (FEED_POLLING_ENABLED and
     * WEBSUB_ENABLED). Omitted = no subscription, whatever a feed advertises.
     */
    websubFlags?: WebSubFlags;
  }
): Promise<FeedPollSummary> {
  const summary: FeedPollSummary = {
    enabled: args.enabled,
    due: 0,
    ingested: 0,
    not_modified: 0,
    errors: 0,
    skipped: 0,
    feed_ids: [],
  };
  if (!args.enabled) return summary;
  const due = await db
    .select({ id: promoterEventFeeds.id, pinged: promoterEventFeeds.pingRequestedAt })
    .from(promoterEventFeeds)
    .where(
      and(
        eq(promoterEventFeeds.enabled, true),
        or(isNull(promoterEventFeeds.nextReadAt), lte(promoterEventFeeds.nextReadAt, args.now)),
        args.onlyPinged ? isNotNull(promoterEventFeeds.pingRequestedAt) : undefined
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
        trigger: f.pinged ? "ping" : "schedule",
      });
      if (r.outcome === "ingested") summary.ingested++;
      else if (r.outcome === "not_modified") summary.not_modified++;
      else if (r.outcome === "skipped") summary.skipped++;
      else summary.errors++;
      if (r.websub && isWebSubEnabled(args.websubFlags)) {
        // A hub that will not take our subscription never fails the read.
        await ensureWebSubSubscription(db, {
          feedId: f.id,
          links: r.websub,
          now: args.now,
          fetchImpl: args.fetchImpl,
          flags: args.websubFlags ?? {},
        }).catch(() => "error");
      }
    } catch {
      summary.errors++;
    }
    // Every outcome serves the ping, so an erroring feed keeps its backoff
    // instead of being re-read every pass.
    await settlePing(db, f.id, args.now).catch(() => undefined);
  }
  return summary;
}

export async function runScheduledFeedPoll(env: {
  DB: D1Database;
  FEED_POLLING_ENABLED?: string;
  WEBSUB_ENABLED?: string;
}): Promise<void> {
  const db = getDb(env.DB);
  const now = new Date();
  const enabled = env.FEED_POLLING_ENABLED === "true";
  const flags = {
    FEED_POLLING_ENABLED: env.FEED_POLLING_ENABLED,
    WEBSUB_ENABLED: env.WEBSUB_ENABLED,
  };
  const s = await pollDueFeeds(db, { now, enabled, websubFlags: flags });
  // OPE-1621 / OPE-1626 — WebSub leases are renewed only while BOTH flags are on.
  const leases = isWebSubEnabled(flags) ? await renewWebSubLeases(db, { now, flags }) : null;
  await logError(env.DB, {
    level: "info",
    source: FEED_POLL_SOURCE,
    message: s.enabled
      ? `feed poll: due ${s.due}, ingested ${s.ingested}, not modified ${s.not_modified}, errors ${s.errors}, skipped ${s.skipped}; ` +
        (leases
          ? `websub renewed ${leases.renewed}, errors ${leases.errors}`
          : "websub off (WEBSUB_ENABLED is not true)")
      : "feed poll: FEED_POLLING_ENABLED is not true; read nothing",
  });
}

/**
 * OPE-1621 — the 10-minute pass: read pinged feeds that are due, so a change
 * ping is served within minutes, not at the next hourly run. Same gate: with
 * the flag off it reads nothing and the pings stay recorded. Logs only when it
 * read something (it fires 144 times a day); its heartbeat probe reads the
 * ping state itself.
 */
export async function runScheduledPingedFeedPass(env: {
  DB: D1Database;
  FEED_POLLING_ENABLED?: string;
  WEBSUB_ENABLED?: string;
}): Promise<FeedPollSummary> {
  const s = await pollDueFeeds(getDb(env.DB), {
    now: new Date(),
    enabled: env.FEED_POLLING_ENABLED === "true",
    onlyPinged: true,
    websubFlags: {
      FEED_POLLING_ENABLED: env.FEED_POLLING_ENABLED,
      WEBSUB_ENABLED: env.WEBSUB_ENABLED,
    },
  });
  if (s.due > 0) {
    await logError(env.DB, {
      level: "info",
      source: FEED_PING_PASS_SOURCE,
      message: `pinged-feed pass: due ${s.due}, ingested ${s.ingested}, not modified ${s.not_modified}, errors ${s.errors}`,
    });
  }
  return s;
}
