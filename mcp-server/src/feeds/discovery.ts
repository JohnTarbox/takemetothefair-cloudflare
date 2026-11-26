/**
 * OPE-1636 part B — probe one promoter's own sites for a usable event feed.
 *
 * What it checks, per domain (the 2026-11-11 hand probe, made repeatable):
 *   1. the home page (and, if it links one, the events page);
 *   2. The Events Calendar's REST API `/wp-json/tribe/events/v1/events?per_page=50`
 *      and, when that answers, the plugin's iCal URL `/events/?ical=1`;
 *   3. iCal links (`.ics`, `webcal://`, `?ical=1`) and published Google Calendar
 *      embeds (`calendar.google.com/calendar/embed?src=…`) in the home page;
 *   4. schema.org Event JSON-LD on the home page and the events page.
 *
 * Courtesy and limits:
 *   - every request goes through fetchConditional: the feed reader's identifying
 *     User-Agent, a timeout, a byte cap, and guardedFetch's SSRF re-check on each
 *     redirect hop;
 *   - a 403 on any page ends the probe of that domain ("blocked"): we do not try
 *     to get around a block (City of Brockton and Visit Vermont blocked the hand
 *     probe);
 *   - the caller passes ONLY domains already on the promoter's domain list
 *     (matchableDomainsFor). A provider-hosted calendar found on the promoter's
 *     page is still reported, marked `provider_hosted`, because registering it
 *     needs a validated contact (checkFeedOwnership rule 2), not the domain;
 *   - it writes nothing.
 */
import { parseIcsFeed, parseTecPage, eventsFromHtml } from "@takemetothefair/utils/feeds";
import { fetchConditional } from "./fetch-feed.js";
import { isCalendarProviderUrl } from "./ownership.js";
import { normalizeCalendarUrl } from "./ical.js";

export type FeedDiscoveryKind = "tec_rest" | "ical" | "jsonld";

export interface FeedDiscoveryCandidate {
  kind: FeedDiscoveryKind;
  /** The URL register_promoter_feed would take. */
  feed_url: string;
  /** Where we found it: `tec_rest_api`, `tec_ical`, `ical_link`, `google_calendar_embed`, `jsonld_home`, `jsonld_events_page`. */
  found_via: string;
  /** Items the feed returned on this probe (TEC: its `total` when given). */
  item_count: number;
  sample_titles: string[];
  /** A calendar on a provider's host (Google, Outlook…): registering needs a validated contact. */
  provider_hosted: boolean;
}

export interface DomainProbeResult {
  domain: string;
  outcome: "found" | "none" | "blocked" | "error";
  candidates: FeedDiscoveryCandidate[];
  /** Requests made, for the run's courtesy accounting. */
  requests: number;
  detail: string | null;
}

const SAMPLE = 5;
const MAX_CALENDAR_LINKS = 2;
const DEFAULT_TZ = "America/New_York";

class Blocked extends Error {}

const titles = (xs: Array<{ title: string | null | undefined }>) =>
  xs
    .map((x) => (x.title ?? "").trim())
    .filter(Boolean)
    .slice(0, SAMPLE);

/** `calendar.google.com/calendar/embed?src=X` → X's public iCal address, or null. */
export function googleEmbedToIcs(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.replace(/&amp;/g, "&"));
  } catch {
    return null;
  }
  if (u.hostname !== "calendar.google.com" || !u.pathname.startsWith("/calendar/embed"))
    return null;
  const src = u.searchParams.get("src");
  return src
    ? `https://calendar.google.com/calendar/ical/${encodeURIComponent(src)}/public/basic.ics`
    : null;
}

/** Calendar addresses a page links or embeds: iCal links and Google Calendar embeds. Pure. */
export function calendarLinksFromHtml(
  html: string,
  pageUrl: string
): Array<{ url: string; via: string }> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].replace(/&amp;/g, "&").trim();
    const gcal = googleEmbedToIcs(raw.startsWith("//") ? `https:${raw}` : raw);
    if (gcal) {
      out.set(gcal, "google_calendar_embed");
      continue;
    }
    if (!/^webcals?:\/\//i.test(raw) && !/\.ics(\?|$)/i.test(raw) && !/[?&]ical=1\b/i.test(raw))
      continue;
    let abs: string;
    try {
      abs = new URL(normalizeCalendarUrl(raw), pageUrl).toString();
    } catch {
      continue;
    }
    if (!out.has(abs)) out.set(abs, "ical_link");
  }
  return [...out.entries()].map(([url, via]) => ({ url, via }));
}

/** The first same-site link whose path is exactly an events listing, or null. Pure. */
export function eventsPageFromHtml(html: string, pageUrl: string): string | null {
  const base = new URL(pageUrl);
  const host = (h: string) => h.toLowerCase().replace(/^www\./, "");
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (host(u.hostname) !== host(base.hostname)) continue;
      if (/^\/(events|calendar|upcoming-events|event-calendar|shows)\/?$/i.test(u.pathname)) {
        u.search = "";
        return u.toString();
      }
    } catch {
      // skip
    }
  }
  return null;
}

function windowDates(now: Date) {
  const start = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 400 * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * Probe one domain. Never throws: a failure is an outcome (`error`, or
 * `blocked` on a 403), with whatever candidates were found before it.
 */
export async function probeDomain(
  domain: string,
  opts: { now: Date; fetchImpl?: typeof fetch }
): Promise<DomainProbeResult> {
  const candidates: FeedDiscoveryCandidate[] = [];
  let requests = 0;
  const { start, end } = windowDates(opts.now);

  /** GET; null on a non-403 failure, Blocked on a 403. */
  const get = async (url: string, accept?: string): Promise<string | null> => {
    requests++;
    try {
      const r = await fetchConditional(url, { fetchImpl: opts.fetchImpl, accept });
      return r.status === "ok" ? r.body : null;
    } catch (err) {
      if (err instanceof Error && /^HTTP 403\b/.test(err.message)) throw new Blocked(url);
      return null;
    }
  };

  const countIcs = (body: string) => {
    try {
      const r = parseIcsFeed(body, {
        windowStart: start,
        windowEnd: end,
        defaultTz: DEFAULT_TZ,
        maxInstances: 500,
      });
      return /BEGIN:VCALENDAR/i.test(body) ? r : null;
    } catch {
      return null;
    }
  };

  const origin = `https://${domain}`;
  try {
    const home = await get(`${origin}/`, "text/html, */*;q=0.5");
    if (home == null) {
      return { domain, outcome: "error", candidates, requests, detail: "home page did not load" };
    }

    // 2. The Events Calendar's REST API, then its iCal URL.
    const tecUrl = `${origin}/wp-json/tribe/events/v1/events`;
    const tecBody = await get(`${tecUrl}?per_page=50`, "application/json");
    // Parse in its own try: only "not JSON" is swallowed here. The iCal GET
    // below must stay OUTSIDE it, or a 403 there (Blocked) would be swallowed
    // too and probing would carry on past a block.
    let tec: { events?: unknown; total?: unknown } | null = null;
    if (tecBody != null) {
      try {
        tec = JSON.parse(tecBody) as { events?: unknown; total?: unknown };
      } catch {
        tec = null; // not JSON: no plugin API here
      }
    }
    if (tec && Array.isArray(tec.events)) {
      const page = parseTecPage(tec);
      candidates.push({
        kind: "tec_rest",
        feed_url: tecUrl,
        found_via: "tec_rest_api",
        item_count: typeof tec.total === "number" ? tec.total : page.events.length,
        sample_titles: titles(page.events),
        provider_hosted: false,
      });
      const icalUrl = `${origin}/events/?ical=1`;
      const ics = await get(icalUrl, "text/calendar");
      const parsed = ics ? countIcs(ics) : null;
      if (parsed) {
        candidates.push({
          kind: "ical",
          feed_url: icalUrl,
          found_via: "tec_ical",
          item_count: parsed.events.length,
          sample_titles: titles(parsed.events),
          provider_hosted: false,
        });
      }
    }

    // 3. iCal links and Google Calendar embeds on the home page.
    const seen = new Set(candidates.map((c) => c.feed_url));
    for (const link of calendarLinksFromHtml(home, `${origin}/`)
      .filter((l) => !seen.has(l.url))
      .slice(0, MAX_CALENDAR_LINKS)) {
      const ics = await get(link.url, "text/calendar");
      const parsed = ics ? countIcs(ics) : null;
      if (!parsed) continue;
      candidates.push({
        kind: "ical",
        feed_url: link.url,
        found_via: link.via,
        item_count: parsed.events.length,
        sample_titles: titles(parsed.events),
        provider_hosted: isCalendarProviderUrl(link.url),
      });
    }

    // 4. schema.org Event JSON-LD: the home page, then the events page.
    const homeEvents = eventsFromHtml(home, `${origin}/`, DEFAULT_TZ);
    if (homeEvents.length) {
      candidates.push({
        kind: "jsonld",
        feed_url: `${origin}/`,
        found_via: "jsonld_home",
        item_count: homeEvents.length,
        sample_titles: titles(homeEvents),
        provider_hosted: false,
      });
    }
    const eventsPage = eventsPageFromHtml(home, `${origin}/`);
    if (eventsPage) {
      const html = await get(eventsPage, "text/html, */*;q=0.5");
      const evs = html ? eventsFromHtml(html, eventsPage, DEFAULT_TZ) : [];
      if (evs.length) {
        candidates.push({
          kind: "jsonld",
          feed_url: eventsPage,
          found_via: "jsonld_events_page",
          item_count: evs.length,
          sample_titles: titles(evs),
          provider_hosted: false,
        });
      }
    }
  } catch (err) {
    if (err instanceof Blocked) {
      // A 403 stops the probe either way; what was already found still counts
      // (MOFGA 2026-11-26: the REST API answered, then an iCal link 403'd).
      return {
        domain,
        outcome: candidates.length ? "found" : "blocked",
        candidates,
        requests,
        detail: `403 on ${err.message}; not probed further`,
      };
    }
    return {
      domain,
      outcome: candidates.length ? "found" : "error",
      candidates,
      requests,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    domain,
    outcome: candidates.length ? "found" : "none",
    candidates,
    requests,
    detail: null,
  };
}
