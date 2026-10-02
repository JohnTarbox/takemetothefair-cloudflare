/**
 * OPE-1285 — list every dated event a promoter newsletter mentions, each with
 * the verbatim words that support it.
 *
 * The model proposes; this file decides. An item survives only when:
 *   1. its excerpt is really in the newsletter (whitespace- and case-folded),
 *   2. the excerpt itself states the item's month AND day, and
 *   3. it has a name.
 * OPE-465's grounding verifier is not built, so the excerpt IS the grounding:
 * no excerpt, no item. A model that invents an event cannot also invent the
 * sentence that announces it.
 *
 * Year handling is deliberately asymmetric. `yearExplicit` records whether the
 * excerpt names the year. A yearless date ("October 3 & 4") is still good
 * enough to MATCH an event we already hold — the year is inferred from when the
 * newsletter arrived — but it never becomes a date citation (OPE-457 refuses
 * those for the same reason) and never a new candidate (see the disposer).
 * Measured on Maine Made's October issue: every workshop, and a Shark Tank
 * airing, is yearless; the one real event in it (Maine Craft Weekend) is
 * already held.
 */
import { WORKERS_AI_MODEL } from "@takemetothefair/constants";
import type { AiBinding } from "../intent-classifier.js";
import { stripForwardedPreamble } from "../email-handlers/submit.js";

/** Prompt input cap. Newsletters are mostly tracker URLs, which are stripped
 *  first: Maine Made's 27,926-char issue is ~9,000 chars without them. */
const MAX_PROMPT_CHARS = 14_000;
/** Measured on the 12 real newsletters (2026-10-02): median ~2.3s, tail 29.4s
 *  on the largest issue (Bangor's ten-event September Spectacular). 2× tail. */
const AI_TIMEOUT_MS = 60_000;
const MAX_ITEMS = 20;

export const ITEMIZER_VERSION = "nl-itemize-2026-10-02-v1";

const SYSTEM_PROMPT = `You read a newsletter from an event organizer and list the EVENTS it announces that a member of the public could attend on a specific date: fairs, festivals, shows, markets, expos, open studios, tours.

Rules:
- Only list an event if the newsletter states its date (month and day).
- "excerpt" MUST be copied word-for-word from the newsletter: the shortest passage (one or two sentences, or a heading plus its date line) that names the event AND states its date. Do not paraphrase, do not fix spelling, do not join distant passages.
- Do NOT list: sponsors, donations, blog posts, product launches, awards, TV or media appearances, sales, deadlines, links whose text is just a label ("Schedule", "Register", "Show details").
- Dates: YYYY-MM-DD. If the newsletter gives no year, use null for the year part by writing "XXXX-MM-DD".
- If the newsletter announces no dated events, return [].

Return ONLY a JSON array, no prose:
[{"name": "...", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD or null", "venue": "... or null", "city": "... or null", "state": "two-letter or null", "excerpt": "..."}]`;

export interface RawItem {
  name?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  venue?: unknown;
  city?: unknown;
  state?: unknown;
  excerpt?: unknown;
}

export interface NewsletterItem {
  name: string;
  /** YYYY-MM-DD; the year is inferred when `yearExplicit` is false. */
  startDate: string;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  state: string | null;
  excerpt: string;
  yearExplicit: boolean;
}

export interface DroppedItem {
  name: string | null;
  /** What the model offered as support, so a reviewer can see WHY it failed. */
  excerpt?: string;
  reason: "no-excerpt" | "excerpt-not-in-body" | "excerpt-has-no-date" | "no-name" | "bad-date";
}

/** Strip `<https://…>` link targets and bare URLs, collapse blank runs. */
export function cleanNewsletterText(text: string): string {
  return stripForwardedPreamble(text)
    .replace(/<https?:\/\/[^>\s]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[image:[^\]]*\]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    // A standalone list marker is layout, not words: Bangor's "Saturday, Sept.
    // 19 ⏎ - ⏎ Stephen King Roadshow…" is one adjacent passage, and the model
    // quotes it without the bullet (measured, dde7e809). A hyphen INSIDE a
    // token ("Aug. 4-8") is untouched.
    .replace(/(^|\s)[-\u2022\u00b7\u25aa]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/**
 * Does the excerpt itself state this month and day? Accepts "Aug. 4-8",
 * "August 4", "October 3 & 4", "Sept 15-16", "July 11th", "8/4". The day must follow the
 * month (US order), optionally after a weekday-less punctuation run.
 */
export function excerptStatesDate(excerpt: string, month: number, day: number): boolean {
  const e = fold(excerpt);
  const abbr = MONTHS[month - 1];
  // The month token must be EXACT, never a prefix: `mar[a-z]*` read the word
  // "market" as March. A full name may sit flush against the previous word —
  // flattened HTML gives "Market NotesJuly 30th" (measured, 678828ed) — except
  // "may", which is a word on its own. An abbreviation needs a word boundary.
  const full = MONTH_NAMES[month - 1];
  const fullRe = full === "may" ? "\\bmay" : full;
  const abbrRe = `\\b${abbr}${month === 9 ? "t?" : ""}`;
  const monthRe = `(?:${fullRe}|${abbrRe})(?![a-z])`;
  // Ordinals ("July 11th", "September 30th") are how half the specimens write
  // a date; without the suffix group the `\\b` after the digits never matches.
  const named = new RegExp(`${monthRe}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g");
  for (const m of e.matchAll(named)) if (Number(m[1]) === day) return true;
  const numeric = new RegExp(`\\b0?${month}/0?${day}\\b`);
  return numeric.test(e);
}

function parseIsoish(s: unknown): { year: number | null; month: number; day: number } | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}|XXXX)-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: m[1] === "XXXX" ? null : Number(m[1]), month, day };
}

/**
 * A yearless date is read as the first occurrence on or after 60 days before
 * the newsletter arrived: a September issue's "October 3" is this October, and
 * a "Sept 15" mentioned in early October is the show that just happened.
 */
export function inferYear(month: number, day: number, receivedAt: Date): number {
  const y = receivedAt.getUTCFullYear();
  const floor = receivedAt.getTime() - 60 * 86_400_000;
  return Date.UTC(y, month - 1, day) >= floor ? y : y + 1;
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null;

/** Steps 1–3 of the header comment. Pure; the model's output is untrusted. */
export function groundItems(
  raw: RawItem[],
  newsletterText: string,
  receivedAt: Date
): { items: NewsletterItem[]; dropped: DroppedItem[] } {
  const body = fold(newsletterText);
  const items: NewsletterItem[] = [];
  const dropped: DroppedItem[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, MAX_ITEMS)) {
    const name = str(r.name);
    const excerpt = str(r.excerpt);
    if (!name) {
      dropped.push({ name: null, reason: "no-name" });
      continue;
    }
    if (!excerpt) {
      dropped.push({ name, reason: "no-excerpt" });
      continue;
    }
    if (!body.includes(fold(excerpt))) {
      dropped.push({ name, excerpt: excerpt.slice(0, 200), reason: "excerpt-not-in-body" });
      continue;
    }
    const start = parseIsoish(r.start_date);
    if (!start) {
      dropped.push({ name, excerpt: excerpt.slice(0, 200), reason: "bad-date" });
      continue;
    }
    if (!excerptStatesDate(excerpt, start.month, start.day)) {
      dropped.push({ name, excerpt: excerpt.slice(0, 200), reason: "excerpt-has-no-date" });
      continue;
    }
    // The year counts as explicit only when the EXCERPT says it — never on the
    // model's word, which fills years in confidently.
    const yearExplicit = start.year !== null && new RegExp(`\\b${start.year}\\b`).test(excerpt);
    const year = yearExplicit ? start.year! : inferYear(start.month, start.day, receivedAt);
    const end = parseIsoish(r.end_date);
    let endDate: string | null = null;
    if (end) {
      const endYear =
        end.year !== null && yearExplicit ? end.year : end.month < start.month ? year + 1 : year;
      endDate = iso(endYear, end.month, end.day);
      if (endDate < iso(year, start.month, start.day)) endDate = null;
    }
    const startDate = iso(year, start.month, start.day);
    const key = `${fold(name)}|${startDate}`;
    if (seen.has(key)) continue; // a newsletter often repeats its headline event
    seen.add(key);
    items.push({
      name,
      startDate,
      endDate,
      venue: str(r.venue),
      city: str(r.city),
      state: str(r.state)?.toUpperCase().slice(0, 2) ?? null,
      excerpt,
      yearExplicit,
    });
  }
  return { items, dropped };
}

/** Pull the first JSON array out of a model response; [] when there is none. */
export function parseItemsResponse(raw: unknown): RawItem[] {
  if (Array.isArray(raw)) return raw as RawItem[];
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "response" in raw
        ? (raw as { response: unknown }).response
        : null;
  if (Array.isArray(text)) return text as RawItem[];
  if (typeof text !== "string") return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed as RawItem[]) : [];
  } catch {
    return [];
  }
}

/** Throws on a model failure; the caller records it and moves on. */
export async function itemizeNewsletter(
  ai: AiBinding,
  bodyText: string,
  receivedAt: Date
): Promise<{ items: NewsletterItem[]; dropped: DroppedItem[]; proposed: number }> {
  const cleaned = cleanNewsletterText(bodyText);
  const res = await Promise.race([
    ai.run(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: cleaned.slice(0, MAX_PROMPT_CHARS) },
      ],
      max_tokens: 2048,
      temperature: 0,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("newsletter-itemize-timeout")), AI_TIMEOUT_MS)
    ),
  ]);
  const raw = parseItemsResponse(res);
  return { ...groundItems(raw, cleaned, receivedAt), proposed: raw.length };
}
