/**
 * OPE-1617 — one read of one registered feed, end to end: polite fetch, parse
 * by kind, ingest (OPE-1613 pipeline), and the feed's polling state.
 *
 * The MCP tool (`ingest_promoter_feed`) and the scheduler both call this, so an
 * operator's manual read and a scheduled read are the same code path.
 *
 * Polling state is written ONLY on a real (non-dry) read:
 *   - 304 Not Modified → no parse, no ingest; `next_read_at` advances.
 *   - success → validators stored, error streak reset, `next_read_at` = interval.
 *   - failure → error streak +1, `next_read_at` backs off (doubling, 7-day cap).
 *
 * OPE-1626 — and on a real read:
 *   - a good read or a 304 stamps `last_ok_at` (the feed-reader probe's clock);
 *   - the FEED_AUTO_DISABLE_AFTER-th consecutive failure switches the feed off
 *     (`enabled = 0`, `disabled_reason`, `disabled_at`) and writes one error row
 *     prefixed FEED_READ_FAILED_FAULT, which FAM-FEED-READ-FAILED matches;
 *   - one `promoter_feed_reads` row records the read, newest
 *     FEED_READ_LOG_KEEP per feed kept.
 * A dry run writes none of these: it is the real path minus the writes.
 */
import { eq, sql } from "drizzle-orm";
import { promoterEventFeeds, promoterFeedReads } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";
import { readTecFeed, type FeedEvent } from "./tec.js";
import { normalizeCalendarUrl, parseIcsFeed } from "./ical.js";
import { readJsonLdSource } from "./jsonld.js";
import { fetchConditional, fetchText, nextReadDelayMs } from "./fetch-feed.js";
import { ingestFeedItems, type IngestReport } from "./ingest.js";
import { discoverHub, type HubLinks } from "./websub.js";

const DAY_MS = 86_400_000;
const DEFAULT_TZ = "America/New_York";

/** OPE-1626 — consecutive failed reads that switch a feed off. */
export const FEED_AUTO_DISABLE_AFTER = 5;
/** OPE-1626 — message prefix of the auto-disable error row; FAM-FEED-READ-FAILED matches it. */
export const FEED_READ_FAILED_FAULT = "feed-read-failed:";
export const FEED_READ_FAILED_SOURCE = "feeds:read-failed";
/** OPE-1626 — run-log rows kept per feed. */
export const FEED_READ_LOG_KEEP = 200;

export type FeedReadTrigger = "schedule" | "ping" | "manual";

export interface FeedRunResult {
  feed_id: string;
  kind: string;
  dry_run: boolean;
  /**
   * not_modified = the server answered 304; nothing was parsed or ingested.
   * skipped = the feed is disabled; nothing was fetched (OPE-1626).
   */
  outcome: "ingested" | "not_modified" | "error" | "skipped";
  error?: string;
  /** OPE-1626 — this failure was the one that switched the feed off. */
  disabled?: boolean;
  window: { start: string; end: string };
  read: {
    complete: boolean;
    pages?: number;
    unmappable_items?: number;
    warnings?: string[];
    calendar_name?: string | null;
    calendar_tz?: string | null;
  };
  next_read_at: string | null;
  report: IngestReport | null;
  /** OPE-1621 — a WebSub hub this read advertised (header or body); the scheduler subscribes. */
  websub?: HubLinks | null;
}

type FeedRow = typeof promoterEventFeeds.$inferSelect;

async function readItems(
  feed: FeedRow,
  opts: { start: string; end: string; dryRun: boolean; fetchImpl?: typeof fetch }
): Promise<
  | { status: "not_modified"; etag: string | null; lastModified: string | null }
  | {
      status: "ok";
      items: FeedEvent[];
      complete: boolean;
      etag: string | null;
      lastModified: string | null;
      meta: FeedRunResult["read"];
      websub: HubLinks | null;
    }
> {
  if (feed.kind === "tec_rest") {
    const r = await readTecFeed(feed.feedUrl, {
      startDate: opts.start,
      endDate: opts.end,
      fetchImpl: opts.fetchImpl,
    });
    // TEC REST has no validators to send back; a read that hit the page cap is partial.
    return {
      status: "ok",
      items: r.events,
      complete: r.pages < 10,
      etag: null,
      lastModified: null,
      meta: { complete: r.pages < 10, pages: r.pages, unmappable_items: r.skipped },
      websub: null,
    };
  }
  // A dry run never sends the stored validators: an operator previewing a feed
  // wants to see its items, not a 304.
  const cond = await fetchConditional(normalizeCalendarUrl(feed.feedUrl), {
    etag: opts.dryRun ? null : feed.httpEtag,
    lastModified: opts.dryRun ? null : feed.httpLastModified,
    fetchImpl: opts.fetchImpl,
  });
  if (cond.status === "not_modified") return cond;
  const websub = discoverHub({
    body: cond.body,
    linkHeader: cond.linkHeader,
    feedUrl: normalizeCalendarUrl(feed.feedUrl),
  });
  if (feed.kind === "ical") {
    if (!/BEGIN:VCALENDAR/i.test(cond.body.slice(0, 2000)))
      throw new Error(
        `not an iCalendar document (content-type ${cond.contentType ?? "unknown"}); for an event page use kind 'jsonld'`
      );
    const r = parseIcsFeed(cond.body, {
      windowStart: opts.start,
      windowEnd: opts.end,
      defaultTz: DEFAULT_TZ,
    });
    return {
      status: "ok",
      items: r.events,
      complete: !r.truncated,
      etag: cond.etag,
      lastModified: cond.lastModified,
      meta: {
        complete: !r.truncated,
        unmappable_items: r.skipped,
        warnings: r.warnings,
        calendar_name: r.calendarName,
        calendar_tz: r.calendarTz,
      },
      websub,
    };
  }
  // jsonld
  const r = await readJsonLdSource(feed.feedUrl, {
    fetchText: (u) => fetchText(u, opts.fetchImpl),
    defaultTz: DEFAULT_TZ,
    startBody: cond.body,
  });
  const items = r.events.filter(
    (e) => (e.endDate ?? e.startDate ?? "") >= opts.start && (e.startDate ?? "") <= opts.end
  );
  // A page that failed or was skipped means the read is partial — no drop detection.
  const complete = r.errors.length === 0 && r.pagesSkipped === 0;
  return {
    status: "ok",
    items,
    complete,
    etag: cond.etag,
    lastModified: cond.lastModified,
    meta: {
      complete,
      pages: r.pagesRead,
      warnings: [
        ...r.errors.map((e) => `page failed: ${e}`),
        ...(r.pagesSkipped ? [`${r.pagesSkipped} event pages not read (page cap)`] : []),
      ],
    },
    websub,
  };
}

/** "HTTP 503" → 503; anything else (timeout, parse error) has no status. */
function httpStatusOf(message: string): number | null {
  const m = /^HTTP (\d{3})\b/.exec(message);
  return m ? Number(m[1]) : null;
}

/**
 * OPE-1626 — one run-log row, then prune the feed's log to the newest
 * FEED_READ_LOG_KEEP. Observability: a failure here never fails the read.
 */
async function recordFeedRead(
  db: Db,
  row: typeof promoterFeedReads.$inferInsert & { feedId: string }
): Promise<void> {
  try {
    await db.insert(promoterFeedReads).values(row);
    await db.run(sql`
      DELETE FROM promoter_feed_reads
      WHERE feed_id = ${row.feedId}
        AND id NOT IN (
          SELECT id FROM promoter_feed_reads WHERE feed_id = ${row.feedId}
          ORDER BY started_at DESC, id DESC LIMIT ${FEED_READ_LOG_KEEP}
        )
    `);
  } catch (error) {
    await logError(db, {
      level: "warn",
      source: "feeds:read-log",
      message: `feed read log write failed for ${row.feedId}`,
      error,
    });
  }
}

export async function runFeedRead(
  db: Db,
  args: {
    feedId: string;
    now: Date;
    dryRun: boolean;
    actor: string;
    startDate?: string;
    endDate?: string;
    fetchImpl?: typeof fetch;
    /** OPE-1626 — what asked for this read, for the run log. Default "manual". */
    trigger?: FeedReadTrigger;
  }
): Promise<FeedRunResult> {
  const [feed] = await db
    .select()
    .from(promoterEventFeeds)
    .where(eq(promoterEventFeeds.id, args.feedId))
    .limit(1);
  if (!feed) throw new Error("feed not found");
  const t = args.now;
  const triggeredBy = args.trigger ?? "manual";
  // finished_at is on the caller's clock: `now` plus the wall time the read took.
  const wallStart = Date.now();
  const finished = () => new Date(t.getTime() + (Date.now() - wallStart));
  const start = args.startDate ?? t.toISOString().slice(0, 10);
  const end = args.endDate ?? new Date(t.getTime() + 400 * DAY_MS).toISOString().slice(0, 10);
  const base: Omit<FeedRunResult, "outcome" | "read" | "next_read_at" | "report"> = {
    feed_id: feed.id,
    kind: feed.kind,
    dry_run: args.dryRun,
    window: { start, end },
  };

  // OPE-1626 — a disabled feed is never fetched (a scheduled pass that raced an
  // auto-disable, or any caller that skipped the enabled check).
  if (!feed.enabled) {
    if (!args.dryRun) {
      await recordFeedRead(db, {
        id: crypto.randomUUID(),
        feedId: feed.id,
        startedAt: t,
        finishedAt: t,
        triggeredBy,
        outcome: "skipped",
        error: feed.disabledReason ?? "feed is disabled",
      });
    }
    return {
      ...base,
      outcome: "skipped",
      error: "feed is disabled",
      read: { complete: false },
      next_read_at: null,
      report: null,
    };
  }

  let read: Awaited<ReturnType<typeof readItems>>;
  try {
    read = await readItems(feed, { start, end, dryRun: args.dryRun, fetchImpl: args.fetchImpl });
  } catch (e) {
    const message = (e as Error).message;
    let next: Date | null = null;
    let disabled = false;
    if (!args.dryRun) {
      const errors = feed.consecutiveErrors + 1;
      disabled = errors >= FEED_AUTO_DISABLE_AFTER;
      next = new Date(t.getTime() + nextReadDelayMs(feed.pollIntervalHours, errors));
      const reason =
        `auto-disabled after ${errors} consecutive failed reads; last: ${message}`.slice(0, 300);
      await db
        .update(promoterEventFeeds)
        .set({
          lastReadAt: t,
          lastReadStatus: `error: ${message}`.slice(0, 300),
          consecutiveErrors: errors,
          nextReadAt: next,
          updatedAt: t,
          ...(disabled ? { enabled: false, disabledReason: reason, disabledAt: t } : {}),
        })
        .where(eq(promoterEventFeeds.id, feed.id));
      await recordFeedRead(db, {
        id: crypto.randomUUID(),
        feedId: feed.id,
        startedAt: t,
        finishedAt: finished(),
        triggeredBy,
        outcome: "error",
        httpStatus: httpStatusOf(message),
        error: message.slice(0, 500),
      });
      if (disabled) {
        await logError(db, {
          level: "error",
          source: FEED_READ_FAILED_SOURCE,
          message:
            `${FEED_READ_FAILED_FAULT} feed ${feed.id} disabled after ${errors} consecutive failed reads; last error: ${message}`.slice(
              0,
              1000
            ),
          context: { feed_id: feed.id, promoter_id: feed.promoterId, feed_url: feed.feedUrl },
        });
      }
    }
    return {
      ...base,
      outcome: "error",
      error: message,
      ...(disabled ? { disabled: true } : {}),
      read: { complete: false },
      next_read_at: next?.toISOString() ?? null,
      report: null,
    };
  }

  const next = new Date(t.getTime() + nextReadDelayMs(feed.pollIntervalHours, 0));
  if (read.status === "not_modified") {
    if (!args.dryRun) {
      await db
        .update(promoterEventFeeds)
        .set({
          lastReadAt: t,
          lastReadStatus: "not modified (304)",
          lastOkAt: t,
          consecutiveErrors: 0,
          nextReadAt: next,
          httpEtag: read.etag,
          httpLastModified: read.lastModified,
          updatedAt: t,
        })
        .where(eq(promoterEventFeeds.id, feed.id));
      await recordFeedRead(db, {
        id: crypto.randomUUID(),
        feedId: feed.id,
        startedAt: t,
        finishedAt: finished(),
        triggeredBy,
        outcome: "not_modified",
        httpStatus: 304,
      });
    }
    return {
      ...base,
      outcome: "not_modified",
      read: { complete: true },
      next_read_at: args.dryRun ? null : next.toISOString(),
      report: null,
    };
  }

  const report = await ingestFeedItems(db, {
    feedId: feed.id,
    items: read.items,
    now: t,
    dryRun: args.dryRun,
    actor: args.actor,
    dropScope: read.complete ? { fromDate: start, toDate: end } : undefined,
  });
  if (!args.dryRun) {
    // ingestFeedItems already stamped last_read_at / status; add the polling state.
    await db
      .update(promoterEventFeeds)
      .set({
        consecutiveErrors: 0,
        lastOkAt: t,
        nextReadAt: next,
        httpEtag: read.etag,
        httpLastModified: read.lastModified,
        updatedAt: t,
      })
      .where(eq(promoterEventFeeds.id, feed.id));
    await recordFeedRead(db, {
      id: crypto.randomUUID(),
      feedId: feed.id,
      startedAt: t,
      finishedAt: finished(),
      triggeredBy,
      outcome: "ok",
      httpStatus: 200,
      itemsRead: report.items_read,
      included: report.included,
      linked: report.linked,
      awaitingReview: report.awaiting_review,
      // "opened" counts replacements too (ingest.ts); a refresh asks nothing new.
      discrepancies: report.discrepancies_opened,
      thirdValues: report.third_values,
    });
  }
  return {
    ...base,
    outcome: "ingested",
    read: read.meta,
    next_read_at: args.dryRun ? null : next.toISOString(),
    report,
    websub: read.websub,
  };
}
