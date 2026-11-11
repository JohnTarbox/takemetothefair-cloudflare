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
 */
import { parseTecPage, tecEventsUrl, type FeedEvent } from "@takemetothefair/utils/feeds";

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
  const doFetch = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 10;

  const out: FeedEvent[] = [];
  let skipped = 0;
  let pages = 0;
  let next: string | null = tecEventsUrl(feedUrl, opts.startDate, opts.endDate);
  while (next && pages < maxPages) {
    const res = await doFetch(next, {
      headers: {
        Accept: "application/json",
        "User-Agent": "MeetMeAtTheFair-FeedReader/1.0 (+https://meetmeatthefair.com)",
      },
    });
    pages++;
    if (!res.ok) throw new Error(`feed HTTP ${res.status} on page ${pages}`);
    const page = parseTecPage(await res.json());
    out.push(...page.events);
    skipped += page.skipped;
    next = page.next;
  }
  return { events: out, pages, skipped };
}
