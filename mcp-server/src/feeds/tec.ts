/**
 * OPE-1613 — The Events Calendar (WordPress) REST connector.
 *
 * Reads `/wp-json/tribe/events/v1/events` with a date range and paging. TEC's
 * `start_date` / `end_date` are the organizer's LOCAL wall time
 * ("2026-03-19 04:30:00") in the event's `timezone` — we keep them as local
 * strings and never convert through a Date, because a wrong offset is exactly
 * the class of error a feed discrepancy exists to catch, and we must not
 * manufacture one of our own.
 *
 * The iCal fallback the ticket names is NOT in this slice (OPE-1617 owns the
 * universal ICS reader); `kind: 'ical'` feeds are refused with a clear reason.
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
  const base = new URL(feedUrl);
  if (!/\/wp-json\/tribe\/events\/v1\/events\/?$/.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/$/, "") + "/wp-json/tribe/events/v1/events";
  }
  base.searchParams.set("per_page", "50");
  base.searchParams.set("start_date", opts.startDate);
  base.searchParams.set("end_date", opts.endDate);

  const out: FeedEvent[] = [];
  let skipped = 0;
  let pages = 0;
  let next: string | null = base.toString();
  while (next && pages < maxPages) {
    const res = await doFetch(next, {
      headers: {
        Accept: "application/json",
        "User-Agent": "MeetMeAtTheFair-FeedReader/1.0 (+https://meetmeatthefair.com)",
      },
    });
    pages++;
    if (!res.ok) throw new Error(`feed HTTP ${res.status} on page ${pages}`);
    const body = (await res.json()) as Json;
    const list = Array.isArray(body.events) ? (body.events as Json[]) : [];
    for (const raw of list) {
      const ev = mapTecEvent(raw);
      if (ev) out.push(ev);
      else skipped++;
    }
    next = str(body.next_rest_url);
  }
  return { events: out, pages, skipped };
}
