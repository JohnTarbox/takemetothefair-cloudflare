/**
 * OPE-1613 / OPE-1625 — the one shape every organizer-feed reader produces, and
 * The Events Calendar (WordPress) REST mapper.
 *
 * Moved here from `mcp-server/src/feeds/tec.ts` (OPE-1625) so the main app's
 * test-submission engine runs the SAME mapper the MCP Worker's feed reader
 * runs; `mcp-server/src/feeds/tec.ts` re-exports these and keeps the paging
 * fetch loop. Pure: no I/O.
 *
 * TEC's `start_date` / `end_date` are the organizer's LOCAL wall time
 * ("2026-03-19 04:30:00") in the event's `timezone` — we keep them as local
 * strings and never convert through a Date, because a wrong offset is exactly
 * the class of error a feed discrepancy exists to catch, and we must not
 * manufacture one of our own.
 */

export interface FeedVenue {
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface FeedEvent {
  externalId: string;
  title: string;
  url: string | null;
  /** Local "YYYY-MM-DD". */
  startDate: string | null;
  endDate: string | null;
  /** Local "HH:MM" 24h, or null for all-day. */
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  timezone: string | null;
  venue: FeedVenue | null;
  organizerEmails: string[];
  imageUrl: string | null;
  /** Plain text (tags stripped). */
  description: string;
  categories: string[];
  cost: string | null;
  /** The feed's own cancelled marker, if it carries one. */
  statusCancelled: boolean;
  /** iCal SEQUENCE / LAST-MODIFIED (OPE-1617), when the source carries them. */
  sequence?: number | null;
  lastModified?: string | null;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** Strip tags and decode the handful of entities TEC emits. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** "2026-03-19 04:30:00" → { date: "2026-03-19", time: "04:30" }. */
export function splitLocal(v: unknown): { date: string | null; time: string | null } {
  const s = str(v);
  if (!s) return { date: null, time: null };
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: m[2] ? `${m[2]}:${m[3]}` : null };
}

function mapVenue(v: unknown): FeedVenue | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Json;
  const venue: FeedVenue = {
    name: str(o.venue),
    address: str(o.address),
    city: str(o.city),
    state: str(o.state) ?? str(o.province) ?? str(o.stateprovince),
    zip: str(o.zip),
  };
  return Object.values(venue).some((x) => x !== null) ? venue : null;
}

export function mapTecEvent(raw: Json): FeedEvent | null {
  const id = raw.id ?? raw.global_id;
  const title = str(raw.title);
  if (id == null || !title) return null;
  const allDay = raw.all_day === true;
  const start = splitLocal(raw.start_date);
  const end = splitLocal(raw.end_date);
  const organizers = Array.isArray(raw.organizer) ? (raw.organizer as Json[]) : [];
  const image =
    raw.image && typeof raw.image === "object" ? str((raw.image as Json).url) : str(raw.image);
  const categories = Array.isArray(raw.categories)
    ? (raw.categories as Json[]).map((c) => str(c?.name)).filter((c): c is string => !!c)
    : [];
  const titleText = htmlToText(title);
  return {
    externalId: String(id),
    title: titleText,
    url: str(raw.url),
    startDate: start.date,
    endDate: end.date,
    startTime: allDay ? null : start.time,
    endTime: allDay ? null : end.time,
    allDay,
    timezone: str(raw.timezone),
    venue: mapVenue(raw.venue),
    organizerEmails: organizers
      .map((o) => str(o?.email)?.toLowerCase() ?? null)
      .filter((e): e is string => !!e),
    imageUrl: image,
    description: htmlToText(typeof raw.description === "string" ? raw.description : ""),
    categories,
    cost: str(raw.cost),
    statusCancelled:
      String(raw.status ?? "").toLowerCase() === "canceled" ||
      String(raw.status ?? "").toLowerCase() === "cancelled",
  };
}

export const TEC_EVENTS_PATH = /\/wp-json\/tribe\/events\/v1\/events\/?$/;

/**
 * The first page URL of a TEC REST read: the site's events endpoint (appended
 * when the caller gave the site root) with a date range and a page size.
 */
export function tecEventsUrl(feedUrl: string, startDate: string, endDate: string): string {
  const base = new URL(feedUrl);
  if (!TEC_EVENTS_PATH.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/$/, "") + "/wp-json/tribe/events/v1/events";
  }
  base.searchParams.set("per_page", "50");
  base.searchParams.set("start_date", startDate);
  base.searchParams.set("end_date", endDate);
  return base.toString();
}

/** One TEC REST page body → its mapped events, the unmappable count and the next page URL. */
export function parseTecPage(body: unknown): {
  events: FeedEvent[];
  skipped: number;
  next: string | null;
} {
  const o = (body && typeof body === "object" ? body : {}) as Json;
  const list = Array.isArray(o.events) ? (o.events as Json[]) : [];
  const events: FeedEvent[] = [];
  let skipped = 0;
  for (const raw of list) {
    const ev = mapTecEvent(raw);
    if (ev) events.push(ev);
    else skipped++;
  }
  return { events, skipped, next: str(o.next_rest_url) };
}
