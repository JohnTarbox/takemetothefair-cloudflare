/**
 * OPE-1617 — schema.org `Event` JSON-LD reader.
 *
 * For organizers with no calendar export, only event pages that carry
 * `<script type="application/ld+json">` Event markup (Squarespace, Wix and most
 * ticketing plugins emit it). The object walk reuses the one
 * `harvest_performers_from_schema_org` already uses (`collectObjects`: arrays
 * and `@graph` nesting), so the two readers cannot disagree about what a node is.
 *
 * Pages are found from ONE starting URL, which is either
 *   - an event page itself (its own Event nodes),
 *   - a listing page (its Event nodes, plus same-host links that look like
 *     event pages, followed up to `maxPages`), or
 *   - a sitemap (`…sitemap….xml`: same-host `<loc>`s that look like event pages).
 *
 * TIME. `startDate` is ISO 8601. "2026-07-04T10:00:00-04:00" is already the
 * organizer's local wall time with its offset, so the wall time is kept as
 * written. A trailing "Z" is UTC and is converted to the default zone (Intl).
 * A date with no time is all-day.
 *
 * External id: the Event's own `@id` or `url`, else the page URL plus start
 * date — stable across reads as long as the organizer's page is.
 */
import { collectObjects } from "../tools/admin-performer-discovery.js";
import { htmlToText, type FeedEvent, type FeedVenue } from "./tec.js";
import { parseLocation, utcToLocal } from "./ical.js";

type Json = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** schema.org Event subtypes whose names do not end in "Event". */
const EVENT_SUBTYPES_WITHOUT_SUFFIX = new Set(["Festival", "Hackathon", "PublicationEvent"]);

const isEventType = (t: unknown): boolean => {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => {
    if (typeof x !== "string") return false;
    const local = x.replace(/^.*[/:#]/, ""); // "https://schema.org/Festival" → "Festival"
    return /Event$/.test(local) || EVENT_SUBTYPES_WITHOUT_SUFFIX.has(local);
  });
};

/** Every ld+json block on a page, parsed; malformed blocks are skipped. */
export function ldJsonBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      // a malformed block on the organizer's site is skipped, not fatal
    }
  }
  return out;
}

/** ISO 8601 date / date-time → local wall date + time. */
export function parseIsoLocal(
  v: unknown,
  defaultTz: string
): { date: string; time: string | null } | null {
  const s = str(v);
  if (!s) return null;
  const m =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      s
    );
  if (!m) return null;
  if (!m[2]) return { date: m[1], time: null };
  if (m[4] === "Z") {
    const [y, mo, d] = m[1].split("-").map(Number);
    return utcToLocal(Date.UTC(y, mo - 1, d, +m[2], +m[3]), defaultTz);
  }
  return { date: m[1], time: `${m[2]}:${m[3]}` };
}

function mapPlace(loc: unknown): FeedVenue | null {
  const node = Array.isArray(loc) ? loc[0] : loc;
  if (typeof node === "string") return parseLocation(node);
  if (!node || typeof node !== "object") return null;
  const o = node as Json;
  // VirtualLocation is not a venue.
  if (o["@type"] === "VirtualLocation") return null;
  const addr = o.address;
  if (typeof addr === "string") {
    const parsed = parseLocation(addr);
    return parsed
      ? { ...parsed, name: str(o.name) ?? parsed.name }
      : { name: str(o.name), address: null, city: null, state: null, zip: null };
  }
  const a = (addr && typeof addr === "object" ? addr : {}) as Json;
  const venue: FeedVenue = {
    name: str(o.name),
    address: str(a.streetAddress),
    city: str(a.addressLocality),
    state: str(a.addressRegion),
    zip: str(a.postalCode),
  };
  return Object.values(venue).some((x) => x !== null) ? venue : null;
}

const imageOf = (v: unknown): string | null => {
  const node = Array.isArray(v) ? v[0] : v;
  if (typeof node === "string") return str(node);
  if (node && typeof node === "object") return str((node as Json).url);
  return null;
};

const costOf = (offers: unknown): string | null => {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  const prices = list
    .map((o) => (o && typeof o === "object" ? (o as Json).price : null))
    .map((p) => (typeof p === "number" ? String(p) : str(p)))
    .filter((p): p is string => !!p);
  if (!prices.length) return null;
  return prices
    .map((p) => (p === "0" || p === "0.00" ? "Free" : /^\d/.test(p) ? `$${p}` : p))
    .join(" / ");
};

export function mapJsonLdEvent(node: Json, pageUrl: string, defaultTz: string): FeedEvent | null {
  const title = str(node.name);
  const start = parseIsoLocal(node.startDate, defaultTz);
  if (!title || !start) return null;
  const end = parseIsoLocal(node.endDate, defaultTz);
  const allDay = start.time === null;
  const url = str(node.url) ?? pageUrl;
  const status = String(node.eventStatus ?? "");
  const organizers = Array.isArray(node.organizer)
    ? node.organizer
    : node.organizer
      ? [node.organizer]
      : [];
  return {
    externalId: str(node["@id"]) ?? (str(node.url) ? `${node.url}` : `${pageUrl}#${start.date}`),
    title: htmlToText(title),
    url,
    startDate: start.date,
    endDate: end?.date ?? start.date,
    startTime: allDay ? null : start.time,
    endTime: allDay ? null : (end?.time ?? null),
    allDay,
    timezone: defaultTz,
    venue: mapPlace(node.location),
    organizerEmails: organizers
      .map((o) => (o && typeof o === "object" ? str((o as Json).email) : null))
      .map((e) => e?.replace(/^mailto:/i, "").toLowerCase() ?? null)
      .filter((e): e is string => !!e),
    imageUrl: imageOf(node.image),
    description: htmlToText(str(node.description) ?? ""),
    categories: [],
    cost: costOf(node.offers),
    statusCancelled: /EventCancelled$/i.test(status),
    sequence: null,
    lastModified: null,
  };
}

/** Event nodes on one page. */
export function eventsFromHtml(html: string, pageUrl: string, defaultTz: string): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const block of ldJsonBlocks(html)) {
    for (const node of collectObjects(block)) {
      if (!isEventType(node["@type"])) continue;
      const ev = mapJsonLdEvent(node, pageUrl, defaultTz);
      if (ev) out.push(ev);
    }
  }
  return out;
}

/** A path that looks like one event's page (WordPress, Squarespace, Wix, TEC). */
const EVENT_PATH = /\/(events?|calendar|happenings|shows?)\/[^/?#]+/i;

/** Same-host links on a listing page that look like event pages. */
export function eventLinksFromHtml(html: string, pageUrl: string): string[] {
  const base = new URL(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(m[1], base);
    } catch {
      continue;
    }
    if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
    if (!EVENT_PATH.test(u.pathname)) continue;
    if (u.pathname.replace(/\/$/, "") === base.pathname.replace(/\/$/, "")) continue;
    u.hash = "";
    out.add(u.toString());
  }
  return [...out];
}

/** Same-host `<loc>` URLs in a sitemap that look like event pages. */
export function eventLinksFromSitemap(xml: string, sitemapUrl: string): string[] {
  const host = new URL(sitemapUrl).host;
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"));
      if (u.host === host && EVENT_PATH.test(u.pathname)) out.add(u.toString());
    } catch {
      // skip
    }
  }
  return [...out];
}

export interface JsonLdReadResult {
  events: FeedEvent[];
  pagesRead: number;
  /** Event pages found but not read because of the page cap. */
  pagesSkipped: number;
  errors: string[];
}

/**
 * Read Event JSON-LD starting from one URL. `fetchText` is the polite fetcher
 * (fetch-feed.ts); a page that fails is recorded, not fatal, unless it is the
 * starting page.
 */
export async function readJsonLdSource(
  startUrl: string,
  opts: {
    fetchText: (url: string) => Promise<string>;
    defaultTz?: string;
    maxPages?: number;
    /** The starting document, already fetched (conditional GET), to avoid a second request. */
    startBody?: string;
  }
): Promise<JsonLdReadResult> {
  const tz = opts.defaultTz ?? "America/New_York";
  const maxPages = opts.maxPages ?? 25;
  const body = opts.startBody ?? (await opts.fetchText(startUrl));
  const isSitemap = /<urlset[\s>]/i.test(body) || /<sitemapindex[\s>]/i.test(body);
  const errors: string[] = [];
  const byId = new Map<string, FeedEvent>();
  if (!isSitemap) for (const ev of eventsFromHtml(body, startUrl, tz)) byId.set(ev.externalId, ev);
  const links = isSitemap
    ? eventLinksFromSitemap(body, startUrl)
    : eventLinksFromHtml(body, startUrl);
  const toRead = links.slice(0, maxPages);
  for (const url of toRead) {
    try {
      const html = await opts.fetchText(url);
      for (const ev of eventsFromHtml(html, url, tz))
        if (!byId.has(ev.externalId)) byId.set(ev.externalId, ev);
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  return {
    events: [...byId.values()],
    pagesRead: 1 + toRead.length,
    pagesSkipped: Math.max(0, links.length - toRead.length),
    errors,
  };
}
