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
 */
import { eq } from "drizzle-orm";
import { promoterEventFeeds } from "../schema.js";
import type { Db } from "../db.js";
import { readTecFeed, type FeedEvent } from "./tec.js";
import { normalizeCalendarUrl, parseIcsFeed } from "./ical.js";
import { readJsonLdSource } from "./jsonld.js";
import { fetchConditional, fetchText, nextReadDelayMs } from "./fetch-feed.js";
import { ingestFeedItems, type IngestReport } from "./ingest.js";

const DAY_MS = 86_400_000;
const DEFAULT_TZ = "America/New_York";

export interface FeedRunResult {
  feed_id: string;
  kind: string;
  dry_run: boolean;
  /** not_modified = the server answered 304; nothing was parsed or ingested. */
  outcome: "ingested" | "not_modified" | "error";
  error?: string;
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
  };
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
  }
): Promise<FeedRunResult> {
  const [feed] = await db
    .select()
    .from(promoterEventFeeds)
    .where(eq(promoterEventFeeds.id, args.feedId))
    .limit(1);
  if (!feed) throw new Error("feed not found");
  const t = args.now;
  const start = args.startDate ?? t.toISOString().slice(0, 10);
  const end = args.endDate ?? new Date(t.getTime() + 400 * DAY_MS).toISOString().slice(0, 10);
  const base: Omit<FeedRunResult, "outcome" | "read" | "next_read_at" | "report"> = {
    feed_id: feed.id,
    kind: feed.kind,
    dry_run: args.dryRun,
    window: { start, end },
  };

  let read: Awaited<ReturnType<typeof readItems>>;
  try {
    read = await readItems(feed, { start, end, dryRun: args.dryRun, fetchImpl: args.fetchImpl });
  } catch (e) {
    const message = (e as Error).message;
    let next: Date | null = null;
    if (!args.dryRun) {
      const errors = feed.consecutiveErrors + 1;
      next = new Date(t.getTime() + nextReadDelayMs(feed.pollIntervalHours, errors));
      await db
        .update(promoterEventFeeds)
        .set({
          lastReadAt: t,
          lastReadStatus: `error: ${message}`.slice(0, 300),
          consecutiveErrors: errors,
          nextReadAt: next,
          updatedAt: t,
        })
        .where(eq(promoterEventFeeds.id, feed.id));
    }
    return {
      ...base,
      outcome: "error",
      error: message,
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
          consecutiveErrors: 0,
          nextReadAt: next,
          httpEtag: read.etag,
          httpLastModified: read.lastModified,
          updatedAt: t,
        })
        .where(eq(promoterEventFeeds.id, feed.id));
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
        nextReadAt: next,
        httpEtag: read.etag,
        httpLastModified: read.lastModified,
        updatedAt: t,
      })
      .where(eq(promoterEventFeeds.id, feed.id));
  }
  return {
    ...base,
    outcome: "ingested",
    read: read.meta,
    next_read_at: args.dryRun ? null : next.toISOString(),
    report,
  };
}
