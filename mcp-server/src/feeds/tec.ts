/**
 * OPE-1613 — The Events Calendar (WordPress) REST connector.
 *
 * Reads `/wp-json/tribe/events/v1/events` with a date range and paging. The
 * item shape (`FeedEvent`) and the mapper live in @takemetothefair/utils/feeds
 * since OPE-1625, so the main app's test-submission engine reads a TEC feed
 * with the same code; this file keeps the paging fetch loop.
 *
 * TEC's `start_date` / `end_date` are the organizer's LOCAL wall time; we keep
 * them as local strings (feed-event.ts says why).
 *
 * OPE-1648 — every page goes through `guardedFetch` (each redirect hop
 * re-checked, the body streamed under a cap, a timeout through the body), and
 * `next_rest_url` comes from the response BODY, so it is followed only while
 * it stays on the feed's own host. A page that points elsewhere ends the read
 * there, and the read is reported partial so drop detection does not mistake
 * the unread pages for removed events.
 */
import { guardedFetch } from "@takemetothefair/site-fetch";
import { parseTecPage, tecEventsUrl, type FeedEvent } from "@takemetothefair/utils/feeds";
import { FEED_USER_AGENT } from "./fetch-feed.js";

/** Same 5 MB cap as the calendar read in fetch-feed.ts. */
const TEC_PAGE_MAX_BYTES = 5 * 1024 * 1024;
const TEC_PAGE_TIMEOUT_MS = 20_000;

export {
  htmlToText,
  mapTecEvent,
  splitLocal,
  type FeedEvent,
  type FeedVenue,
} from "@takemetothefair/utils/feeds";

export interface TecReadResult {
  events: FeedEvent[];
  pages: number;
  /** Items the mapper could not use (no id or no title). */
  skipped: number;
  /**
   * OPE-1648 — set when a page's `next_rest_url` pointed off the feed's host
   * and paging stopped there. The read is then partial.
   */
  refusedNextHost: string | null;
}

/** Same host, ignoring a leading `www.` (WordPress sites commonly bounce between the two). */
function sameSite(a: URL, b: URL): boolean {
  const h = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
  return h(a) === h(b);
}

/**
 * Read every page of a TEC REST feed between two local dates. Bounded at
 * `maxPages` so a misbehaving site cannot hold an operator's call open.
 */
export async function readTecFeed(
  feedUrl: string,
  opts: {
    startDate: string;
    endDate: string;
    fetchImpl?: typeof fetch;
    maxPages?: number;
  }
): Promise<TecReadResult> {
  const maxPages = opts.maxPages ?? 10;

  const out: FeedEvent[] = [];
  let skipped = 0;
  let pages = 0;
  let refusedNextHost: string | null = null;
  const first = tecEventsUrl(feedUrl, opts.startDate, opts.endDate);
  const home = new URL(first);
  let next: string | null = first;
  while (next && pages < maxPages) {
    const res = await guardedFetch(next, {
      accept: "application/json",
      headers: { "User-Agent": FEED_USER_AGENT },
      maxBytes: TEC_PAGE_MAX_BYTES,
      timeoutMs: TEC_PAGE_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
    pages++;
    if (!res.ok) {
      res.cancel();
      throw new Error(`feed HTTP ${res.status} on page ${pages}`);
    }
    const page = parseTecPage(await res.json());
    out.push(...page.events);
    skipped += page.skipped;
    next = page.next;
    if (next) {
      let target: URL | null = null;
      try {
        target = new URL(next, home);
      } catch {
        target = null;
      }
      if (!target || !sameSite(target, home)) {
        refusedNextHost = target ? target.hostname : String(next).slice(0, 200);
        console.warn(
          `[feeds/tec] refused next_rest_url off the feed host: feed=${home.hostname} next_host=${refusedNextHost} after_page=${pages}`
        );
        next = null;
      } else {
        next = target.href;
      }
    }
  }
  return { events: out, pages, skipped, refusedNextHost };
}
