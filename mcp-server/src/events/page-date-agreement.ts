/**
 * OPE-1586 — does the organizer's page, read NOW, agree with our start date?
 *
 * `ready` (tentative-queue.ts) proves a citation EXISTS. It never proved the
 * cited page says what we say: the OPE-612 drains found 9 of 33 hand-checked
 * `ready`-tier citations wrong, stale or disagreeing, and two live specimens
 * would have passed `ready` untouched:
 *   - biddeford-gun-show — the page says "May 15th & 16th, 2027 (Tentative)",
 *     our dates match exactly, and the organizer has explicitly NOT committed;
 *   - brookfield-orchards — an active citation whose page listed Sep 12–13
 *     while we stored Oct 17.
 *
 * John's ruling (2026-11-16, option 2): promote TENTATIVE → SCHEDULED only when
 * a fresh read agrees — our start date is on the page, and no "tentative" /
 * "TBA" / "to be announced" / "pending" hedge sits near it. Anything that can't
 * be confirmed stays TENTATIVE, with the reason recorded.
 *
 * Pure: no I/O, so every boundary below is pinned by a test without a network.
 * The asymmetry is deliberate throughout — a false HOLD costs one manual click
 * (today's state); a false PROMOTE advertises an event that may not happen. So
 * when in doubt this returns a hold.
 */
import { htmlToPlainText } from "@takemetothefair/utils";

export type DateAgreement =
  | { agrees: true; matched: string; via: "text" | "json-ld" }
  | { agrees: false; reason: DisagreeReason; detail?: string };

export type DisagreeReason =
  /** Our start date is not on the page (different date, script- or image-rendered, stale edition). */
  | "date_absent"
  /** Our date is there, but a hedge word sits near it. */
  | "hedged"
  /** The date appears only with a DIFFERENT year attached (e.g. last year's edition). */
  | "year_mismatch"
  /** The page text is empty — nothing to read (image-only or JS-rendered). */
  | "no_text";

const MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may", "may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
] as const;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Hedge words. John's list ("tentative", "TBA", "to be announced", "pending")
 * plus the near-synonyms an organizer uses for the same non-commitment, and
 * postponed/cancelled — a promotion onto a page that says "CANCELLED" beside
 * the date is the worst false positive this rule could make, and a false hold
 * on a weather-policy sentence is cheap.
 */
const HEDGE =
  /\b(tentative(?:ly)?|tba|tbd|to be (?:announced|determined|confirmed)|pending|postponed|cancell?ed|rescheduled|subject to change)\b/i;

/**
 * How far either side of a date mention a hedge counts as "near it". Scoped,
 * because the analyst's hand-check (2026-11-16) found pages that pass by hand
 * but carry "TBA" elsewhere — PTTF's "more info TBA" under the crafters list —
 * and "canceled" in refund/weather policy (Sparkling Lights, ZooLights).
 */
export const HEDGE_WINDOW_CHARS = 120;

/** How far after a "Month Day" a year may sit and still belong to it ("November 20 - January 3, 2027" is not). */
const ATTACHED_YEAR_CHARS = 12;

export interface CalendarDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  /** 0 = Sunday */
  weekday: number;
}

/** The calendar date an instant falls on in America/New_York — the zone every listing renders in. */
export function newYorkDate(d: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase()),
  };
}

/** Page text with link targets removed — a URL like `/event/x/2026-11-28/` is not the page SAYING a date. */
export function pageText(html: string): string {
  return htmlToPlainText(html)
    .replace(/\((?:https?:|mailto:)[^)]*\)/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ");
}

interface Mention {
  index: number;
  text: string;
  /** A year written with the date (4-digit or 2-digit in a numeric form), if any. */
  year: number | null;
  /**
   * Weekdays written just before the date ("Sat, Nov 21"; "Friday & Saturday,
   * Nov 27-28" gives both), or null when none is written.
   */
  weekdays: number[] | null;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every place the text names our month + day, in any of the common forms. */
function findMentions(text: string, want: CalendarDate): Mention[] {
  const out: Mention[] = [];
  const names = MONTHS[want.month - 1].map(escapeRe).join("|");
  const day = String(want.day);
  const dayRe = `0?${day}(?:st|nd|rd|th)?`;

  const weekdayBefore = (idx: number): number[] | null => {
    const before = text.slice(Math.max(0, idx - 40), idx).toLowerCase();
    // Whole weekday words only: "Wedding Show Dec 6" must not read as Wednesday.
    const run = before.match(
      /(?:\b(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\b\.?\s*(?:,|&|and|-|–|\/)?\s*)+$/
    );
    if (!run) return null;
    const days = [...run[0].matchAll(/(sun|mon|tue|wed|thu|fri|sat)/g)].map((d) =>
      WEEKDAYS.findIndex((w) => w.startsWith(d[1]))
    );
    return days.length > 0 ? days : null;
  };
  const yearAfter = (end: number): number | null => {
    const tail = text.slice(end, end + ATTACHED_YEAR_CHARS);
    const m = tail.match(/^[\s,.]*(?:\(?\s*)?(20\d{2})\b/);
    return m ? Number(m[1]) : null;
  };

  // "November 20", "Nov. 20th", "Sat, Nov 20, 2026", "November 20-22"
  const md = new RegExp(`\\b(?:${names})\\.?\\s+${dayRe}(?![0-9])`, "gi");
  for (const m of text.matchAll(md)) {
    const idx = m.index ?? 0;
    out.push({
      index: idx,
      text: m[0],
      year: yearAfter(idx + m[0].length),
      weekdays: weekdayBefore(idx),
    });
  }
  // "20 November", "20th Nov 2026"
  const dm = new RegExp(`(?<![0-9])${dayRe}\\s+(?:of\\s+)?(?:${names})\\b\\.?`, "gi");
  for (const m of text.matchAll(dm)) {
    const idx = m.index ?? 0;
    out.push({
      index: idx,
      text: m[0],
      year: yearAfter(idx + m[0].length),
      weekdays: weekdayBefore(idx),
    });
  }
  // "11/20/2026", "11/20/26", "11-20-2026" — US order only; a bare "11/20" is
  // too easily a score or a ratio, so a numeric form must carry its year.
  const num = new RegExp(
    `(?<![0-9/])0?${want.month}[/-]0?${day}[/-](20\\d{2}|\\d{2})(?![0-9/])`,
    "g"
  );
  for (const m of text.matchAll(num)) {
    const y = Number(m[1]);
    out.push({
      index: m.index ?? 0,
      text: m[0],
      year: y < 100 ? 2000 + y : y,
      weekdays: weekdayBefore(m.index ?? 0),
    });
  }
  // ISO "2026-11-20"
  const mm = String(want.month).padStart(2, "0");
  const dd = String(want.day).padStart(2, "0");
  for (const m of text.matchAll(new RegExp(`\\b(20\\d{2})-${mm}-${dd}\\b`, "g"))) {
    out.push({ index: m.index ?? 0, text: m[0], year: Number(m[1]), weekdays: null });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * schema.org `startDate` values in the page's JSON-LD (stripped from the text
 * view with every other script). An organizer who publishes structured data
 * has stated the date more precisely than any prose, so it counts on its own —
 * unless the same block says the event is not going ahead as scheduled.
 */
function jsonLdAgrees(html: string, want: CalendarDate): string | null {
  const blocks = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi
  );
  const ymd = `${want.year}-${String(want.month).padStart(2, "0")}-${String(want.day).padStart(2, "0")}`;
  for (const b of blocks) {
    const body = b[1];
    if (/EventPostponed|EventCancelled|EventRescheduled/i.test(body)) continue;
    const m = body.match(new RegExp(`"startDate"\\s*:\\s*"(${ymd})`));
    if (m) return `startDate ${m[1]}`;
  }
  return null;
}

/**
 * The verdict for one page. Order matters, and each step is a reason to HOLD:
 *
 *  1. Find every mention of our month+day.
 *  2. A mention with a year attached counts only if it is OUR year. A mention
 *     with a weekday attached counts only if it is OUR weekday — this is what
 *     catches a stale edition that omits the year ("Saturday, November 21" on a
 *     page for a year when the 21st was a Friday).
 *  3. A year-less mention counts only when our year appears SOMEWHERE in the
 *     page text (a heading, the footer) — the analyst's ZooLights / Thompson's
 *     Point / Noah Webster specimens print "November 20" with the year only in
 *     a heading. A page that names our day but never our year is a hold.
 *  4. A hedge near ANY counting mention holds the whole page — Biddeford's
 *     "(Tentative)" sits beside an otherwise perfect match.
 */
export function pageAgreesWithStartDate(html: string, startDate: Date): DateAgreement {
  const want = newYorkDate(startDate);
  const text = pageText(html);

  const ld = jsonLdAgrees(html, want);

  if (text.replace(/\s+/g, "").length < 40) {
    if (ld) return { agrees: true, matched: ld, via: "json-ld" };
    return { agrees: false, reason: "no_text" };
  }

  const mentions = findMentions(text, want);
  const yearOnPage = new RegExp(`\\b${want.year}\\b`).test(text);

  let sawWrongYear = false;
  const counting = mentions.filter((m) => {
    if (m.weekdays != null && !m.weekdays.includes(want.weekday)) return false;
    if (m.year != null) {
      if (m.year !== want.year) {
        sawWrongYear = true;
        return false;
      }
      return true;
    }
    return yearOnPage;
  });

  if (counting.length === 0) {
    if (ld) return { agrees: true, matched: ld, via: "json-ld" };
    if (sawWrongYear) return { agrees: false, reason: "year_mismatch" };
    return { agrees: false, reason: "date_absent" };
  }

  for (const m of counting) {
    const lo = Math.max(0, m.index - HEDGE_WINDOW_CHARS);
    const hi = Math.min(text.length, m.index + m.text.length + HEDGE_WINDOW_CHARS);
    const near = text.slice(lo, hi);
    const h = near.match(HEDGE);
    if (h) {
      return {
        agrees: false,
        reason: "hedged",
        detail: `"${h[0]}" near "${m.text.trim()}"`,
      };
    }
  }

  const first = counting[0];
  return {
    agrees: true,
    matched: text
      .slice(first.index, first.index + first.text.length + ATTACHED_YEAR_CHARS)
      .split("\n")[0]
      .trim(),
    via: "text",
  };
}
