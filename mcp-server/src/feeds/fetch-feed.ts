/**
 * OPE-1617 — polite fetching for organizer feeds.
 *
 * Every read of an organizer's server goes through here, so the courtesy rules
 * live in one place:
 *   - an identifying User-Agent with a contact URL;
 *   - a conditional GET (If-None-Match / If-Modified-Since from the last good
 *     read), so an unchanged feed costs the organizer a 304 and us no work;
 *   - a timeout and a body-size cap, so a slow or huge site cannot hold a run;
 *   - per-feed backoff on errors (`nextReadDelayMs`), applied by the scheduler.
 */

export const FEED_USER_AGENT = "MeetMeAtTheFair-FeedReader/1.0 (+https://meetmeatthefair.com)";
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export type ConditionalResult =
  | { status: "not_modified"; etag: string | null; lastModified: string | null }
  | {
      status: "ok";
      body: string;
      etag: string | null;
      lastModified: string | null;
      contentType: string | null;
      finalUrl: string;
    };

export async function fetchConditional(
  url: string,
  opts: {
    etag?: string | null;
    lastModified?: string | null;
    fetchImpl?: typeof fetch;
    accept?: string;
  } = {}
): Promise<ConditionalResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "User-Agent": FEED_USER_AGENT,
    Accept: opts.accept ?? "text/calendar, application/xml, text/html;q=0.9, */*;q=0.5",
  };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;
  const res = await doFetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  if (res.status === 304) {
    return {
      status: "not_modified",
      etag: etag ?? opts.etag ?? null,
      lastModified: lastModified ?? opts.lastModified ?? null,
    };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error(`body is ${declared} bytes, over the ${MAX_BYTES} cap`);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error(`body is over the ${MAX_BYTES}-byte cap`);
  return {
    status: "ok",
    body,
    etag,
    lastModified,
    contentType: res.headers.get("content-type"),
    finalUrl: res.url || url,
  };
}

/** Plain GET for secondary pages (JSON-LD event pages): no caching, same courtesy. */
export async function fetchText(url: string, fetchImpl?: typeof fetch): Promise<string> {
  const r = await fetchConditional(url, { fetchImpl, accept: "text/html, */*;q=0.5" });
  if (r.status !== "ok") throw new Error("unexpected 304 on an unconditional GET");
  return r.body;
}

export const DEFAULT_POLL_HOURS = 6;
const MAX_BACKOFF_MS = 7 * 86_400_000;

/**
 * When to read again: the feed's own interval after a good read; after N
 * consecutive errors, the interval doubled N times, capped at 7 days.
 */
export function nextReadDelayMs(pollIntervalHours: number, consecutiveErrors: number): number {
  const base = Math.max(1, pollIntervalHours) * 3_600_000;
  if (consecutiveErrors <= 0) return base;
  return Math.min(base * 2 ** Math.min(consecutiveErrors, 10), MAX_BACKOFF_MS);
}
