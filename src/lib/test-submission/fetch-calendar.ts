/**
 * OPE-1625 — read a pasted calendar URL for the public "Check my calendar"
 * page, safely, and turn it into feed items with the pipeline's own readers.
 *
 * SSRF. The URL is the visitor's, so every request goes through the house
 * guarded fetch (@takemetothefair/site-fetch `guardedFetch`, OPE-1370), which
 * already refuses non-http(s) schemes and internal hosts — localhost and
 * `.local`/`.internal` names, loopback / private / link-local (incl. the
 * 169.254.169.254 metadata address) / CGNAT IPv4 in every numeric encoding,
 * `::1`, `fc00::/7`, `fe80::/10`, mapped and NAT64 IPv6 — and re-checks each
 * redirect hop it follows by hand (`redirect: "manual"`), with a hop cap, a
 * timeout that covers the body, and a streamed size cap. On top of that, this
 * module's `checkHop` runs on every hop too:
 *   - only the default port for the scheme (no `:8080`, no `:22`);
 *   - the host's DNS answers (A and AAAA, over DNS-over-HTTPS) must all be
 *     public. A lookup that FAILS is allowed through (the string check already
 *     passed, and Workers' own fetch refuses private ranges); an answer that is
 *     private is refused. Residual: a host can still change its answer between
 *     our lookup and the fetch's (rebinding TOCTOU), which Workers cannot pin.
 *
 * WHAT IT READS, by what the URL returns: an iCalendar document (Google /
 * Outlook / any `.ics`, `webcal://` accepted); The Events Calendar REST JSON
 * (or a WordPress site that carries TEC, whose REST feed we then read); else an
 * HTML page's schema.org Event JSON-LD, following up to a few same-host event
 * pages. Every extra page is another guarded fetch.
 *
 * Nothing here touches the database.
 */
import {
  GuardedFetchError,
  assertFetchableUrl,
  guardedFetch,
  isBlockedSsrfHost,
} from "@takemetothefair/site-fetch";
import {
  TEC_EVENTS_PATH,
  addDays,
  normalizeCalendarUrl,
  parseIcsFeed,
  parseTecPage,
  readJsonLdSource,
  tecEventsUrl,
  type FeedEvent,
} from "@takemetothefair/utils/feeds";

export const CHECK_MAX_BYTES = 2 * 1024 * 1024;
export const CHECK_TIMEOUT_MS = 10_000;
export const CHECK_MAX_REDIRECTS = 5;
/** Extra event pages followed from a listing page (schema.org reader). */
export const CHECK_MAX_EVENT_PAGES = 5;
export const CHECK_MAX_TEC_PAGES = 3;
/** The window we show: a month back (so recent past items show as skipped) to 400 days ahead. */
export const CHECK_DAYS_BACK = 30;
export const CHECK_DAYS_AHEAD = 400;
const DEFAULT_TZ = "America/New_York";
const USER_AGENT = "MeetMeAtTheFair-CalendarCheck/1.0 (+https://meetmeatthefair.com)";

export type CalendarFetchErrorCode =
  "invalid_url" | "blocked_url" | "fetch_failed" | "too_large" | "timeout";

export class CalendarFetchError extends Error {
  readonly code: CalendarFetchErrorCode;
  constructor(code: CalendarFetchErrorCode, message: string) {
    super(message);
    this.name = "CalendarFetchError";
    this.code = code;
  }
}

/** A host's A + AAAA answers. Injected in tests; DNS-over-HTTPS in production. */
export type ResolveHost = (host: string) => Promise<string[]>;

const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** A and AAAA records over Cloudflare's DNS-over-HTTPS JSON API. Empty on any failure. */
export const dohResolve: ResolveHost = async (host) => {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
      for (const a of body.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
    } catch {
      // fail open: see the header
    }
  }
  return out;
};

const isIpLiteral = (host: string) =>
  host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host);

/** The per-hop check on top of guardedFetch's protocol + host check. */
export function hopChecker(resolve: ResolveHost) {
  return async (url: URL): Promise<void> => {
    if (url.port !== "") {
      throw new GuardedFetchError("blocked_host", `Port ${url.port} is not allowed`, {
        url: url.href,
      });
    }
    const host = url.hostname.replace(/\.+$/, "");
    if (isIpLiteral(host)) return; // already judged by isBlockedSsrfHost
    const ips = await resolve(host).catch(() => [] as string[]);
    const bad = ips.find((ip) => isBlockedSsrfHost(ip.includes(":") ? `[${ip}]` : ip));
    if (bad)
      throw new GuardedFetchError("blocked_host", `${host} resolves to a private address`, {
        url: url.href,
      });
  };
}

/** Parse + statically validate a pasted URL. Throws `CalendarFetchError`. */
export function validateCalendarUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(normalizeCalendarUrl(raw));
  } catch {
    throw new CalendarFetchError("invalid_url", "That is not a web address we can read.");
  }
  try {
    assertFetchableUrl(url);
  } catch {
    throw new CalendarFetchError(
      "blocked_url",
      "We only read public http:// or https:// addresses."
    );
  }
  if (url.port !== "")
    throw new CalendarFetchError(
      "blocked_url",
      "We only read addresses on the standard web ports (no :port)."
    );
  if (url.username || url.password)
    throw new CalendarFetchError(
      "blocked_url",
      "Remove the user name and password from the address."
    );
  return url;
}

function translate(e: unknown): CalendarFetchError {
  if (e instanceof CalendarFetchError) return e;
  if (e instanceof GuardedFetchError) {
    if (
      e.code === "blocked_host" ||
      e.code === "blocked_protocol" ||
      e.code === "invalid_redirect" ||
      e.code === "invalid_url"
    )
      return new CalendarFetchError(
        "blocked_url",
        "We only read public http:// or https:// addresses."
      );
    if (e.code === "too_large")
      return new CalendarFetchError(
        "too_large",
        `The page is larger than ${CHECK_MAX_BYTES / 1024 / 1024} MB, so we stopped reading it.`
      );
    if (e.code === "timeout")
      return new CalendarFetchError("timeout", "The site took too long to answer.");
    if (e.code === "too_many_redirects")
      return new CalendarFetchError("fetch_failed", "The address redirects too many times.");
  }
  return new CalendarFetchError("fetch_failed", "We could not read that address.");
}

interface Fetched {
  body: string;
  finalUrl: string;
  contentType: string | null;
}

export interface CalendarDeps {
  resolveHost?: ResolveHost;
}

async function getText(url: string, deps: CalendarDeps, accept: string): Promise<Fetched> {
  try {
    const res = await guardedFetch(url, {
      maxBytes: CHECK_MAX_BYTES,
      timeoutMs: CHECK_TIMEOUT_MS,
      maxRedirects: CHECK_MAX_REDIRECTS,
      accept,
      headers: { "User-Agent": USER_AGENT },
      checkHop: hopChecker(deps.resolveHost ?? dohResolve),
    });
    if (!res.ok) {
      res.cancel();
      throw new CalendarFetchError("fetch_failed", `The site answered HTTP ${res.status}.`);
    }
    return {
      body: await res.text(),
      finalUrl: res.url,
      contentType: res.headers.get("content-type"),
    };
  } catch (e) {
    throw translate(e);
  }
}

export interface CalendarRead {
  kind: "ical" | "tec_rest" | "jsonld";
  items: FeedEvent[];
  finalUrl: string;
  calendarName: string | null;
  pagesRead: number;
  notes: string[];
  window: { start: string; end: string };
}

async function readTec(
  firstUrl: string,
  deps: CalendarDeps,
  window: { start: string; end: string },
  firstBody?: unknown
): Promise<{ items: FeedEvent[]; pages: number; notes: string[]; finalUrl: string }> {
  const items: FeedEvent[] = [];
  const notes: string[] = [];
  let pages = 0;
  let skipped = 0;
  let next: string | null = firstUrl;
  let finalUrl = firstUrl;
  let body: unknown = firstBody;
  while (next && pages < CHECK_MAX_TEC_PAGES) {
    if (body === undefined) {
      const r = await getText(next, deps, "application/json");
      finalUrl = pages === 0 ? r.finalUrl : finalUrl;
      try {
        body = JSON.parse(r.body);
      } catch {
        throw new CalendarFetchError("fetch_failed", "The events feed did not return JSON.");
      }
    }
    pages++;
    const page = parseTecPage(body);
    items.push(...page.events);
    skipped += page.skipped;
    next = page.next;
    body = undefined;
  }
  if (next) notes.push(`We read the first ${CHECK_MAX_TEC_PAGES} pages of the events feed only.`);
  if (skipped) notes.push(`${skipped} feed item(s) had no id or title, so we could not use them.`);
  const inWindow = items.filter(
    (e) => (e.endDate ?? e.startDate ?? "") >= window.start && (e.startDate ?? "") <= window.end
  );
  return { items: inWindow, pages, notes, finalUrl };
}

const looksLikeTecSite = (html: string) =>
  /tribe-events|\/wp-json\/tribe\/events|the-events-calendar/i.test(html);

/**
 * Fetch and parse one pasted URL. Throws `CalendarFetchError` for a URL we will
 * not or cannot read; an unreadable-but-fetched page returns zero items and a note.
 */
export async function readCalendarUrl(
  raw: string,
  opts: { now: Date; deps?: CalendarDeps }
): Promise<CalendarRead> {
  const deps = opts.deps ?? {};
  const url = validateCalendarUrl(raw);
  const today = opts.now.toISOString().slice(0, 10);
  const window = { start: addDays(today, -CHECK_DAYS_BACK), end: addDays(today, CHECK_DAYS_AHEAD) };

  if (TEC_EVENTS_PATH.test(url.pathname)) {
    const r = await readTec(tecEventsUrl(url.href, window.start, window.end), deps, window);
    return {
      kind: "tec_rest",
      items: r.items,
      finalUrl: r.finalUrl,
      calendarName: null,
      pagesRead: r.pages,
      notes: r.notes,
      window,
    };
  }

  const first = await getText(
    url.href,
    deps,
    "text/calendar, application/json;q=0.9, text/html;q=0.8, */*;q=0.5"
  );
  const head = first.body.slice(0, 2000);
  if (/BEGIN:VCALENDAR/i.test(head)) {
    const r = parseIcsFeed(first.body, {
      windowStart: window.start,
      windowEnd: window.end,
      defaultTz: DEFAULT_TZ,
      maxInstances: 500,
    });
    const notes = [...r.warnings];
    if (r.skipped) notes.push(`${r.skipped} calendar entr(ies) had no date we could read.`);
    return {
      kind: "ical",
      items: r.events,
      finalUrl: first.finalUrl,
      calendarName: r.calendarName,
      pagesRead: 1,
      notes,
      window,
    };
  }
  if (/json/i.test(first.contentType ?? "") || /^\s*[{[]/.test(head)) {
    let json: unknown = null;
    try {
      json = JSON.parse(first.body);
    } catch {
      json = null;
    }
    if (json && typeof json === "object" && Array.isArray((json as { events?: unknown }).events)) {
      const r = await readTec(first.finalUrl, deps, window, json);
      return {
        kind: "tec_rest",
        items: r.items,
        finalUrl: first.finalUrl,
        calendarName: null,
        pagesRead: r.pages,
        notes: r.notes,
        window,
      };
    }
  }

  // An HTML page (or a sitemap): schema.org Event JSON-LD.
  let pagesRead = 1;
  const notes: string[] = [];
  const ld = await readJsonLdSource(first.finalUrl, {
    fetchText: async (u) => {
      pagesRead++;
      return (await getText(u, deps, "text/html, */*;q=0.5")).body;
    },
    defaultTz: DEFAULT_TZ,
    maxPages: CHECK_MAX_EVENT_PAGES,
    startBody: first.body,
  });
  if (ld.errors.length) notes.push(`${ld.errors.length} event page(s) could not be read.`);
  if (ld.pagesSkipped)
    notes.push(
      `We read the first ${CHECK_MAX_EVENT_PAGES} event pages linked from this page only.`
    );
  const items = ld.events.filter(
    (e) => (e.endDate ?? e.startDate ?? "") >= window.start && (e.startDate ?? "") <= window.end
  );
  if (!ld.events.length && looksLikeTecSite(first.body)) {
    // A WordPress site running The Events Calendar: read its REST feed instead.
    const origin = new URL(first.finalUrl).origin;
    try {
      const r = await readTec(tecEventsUrl(origin, window.start, window.end), deps, window);
      return {
        kind: "tec_rest",
        items: r.items,
        finalUrl: r.finalUrl,
        calendarName: null,
        pagesRead: pagesRead + r.pages,
        notes: ["This site uses The Events Calendar; we read its events feed.", ...r.notes],
        window,
      };
    } catch {
      notes.push("This site seems to use The Events Calendar, but its events feed did not answer.");
    }
  }
  if (!ld.events.length)
    notes.push(
      "We found no event data on this page. Paste your calendar's iCal (.ics) address, or a page that carries schema.org Event markup."
    );
  return {
    kind: "jsonld",
    items,
    finalUrl: first.finalUrl,
    calendarName: null,
    pagesRead,
    notes,
    window,
  };
}
