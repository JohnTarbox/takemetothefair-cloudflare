/**
 * OPE-1512 — the "vendors wanted" call on an event's commercial-vendor lane.
 *
 * A vendor's first question before applying is not "what does a booth cost" but
 * "do they want what I sell" — and nothing on the record could say. These two
 * lists, stored per `event_applications` row, carry the organizer's answer:
 * `categories_wanted` ("Looking for: pottery, woodworking") and
 * `categories_full` ("Full: jewelry, candles").
 *
 * ── No controlled vocabulary, on purpose ─────────────────────────────────
 *
 * The ticket says to draw from the vocabulary vendors use and not invent a
 * parallel list. That vocabulary is `vendors.sells_category` (OPE-1164), which
 * is free text with "no controlled list yet (a separate decision)". So these are
 * free text in the SAME space — normalized the same way, never mapped onto a
 * list we made up. When OPE-1164's list lands, both sides get constrained
 * together.
 *
 * Pure, so the app and the MCP Worker share one normalizer and one
 * "is this call current" rule.
 */
import { hasCalendarDayPassed } from "@takemetothefair/datetime";
import { decodeHtmlEntities } from "./index";

/** Max categories per list — a call naming more than this is a paste, not a call. */
export const VENDOR_CALL_MAX_CATEGORIES = 25;
/** Max characters per category — "Hand-poured soy candles" fits; a sentence does not. */
export const VENDOR_CALL_MAX_CATEGORY_CHARS = 60;

/**
 * Trim, decode entities, collapse whitespace, drop blanks, dedupe
 * case-insensitively (first spelling wins), keep input order.
 *
 * Throws on a list that is too long or an entry that is too long, rather than
 * silently truncating: a truncated call says something the organizer did not.
 */
export function normalizeVendorCategories(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const v = decodeHtmlEntities(String(raw)).replace(/\s+/g, " ").trim();
    if (!v) continue;
    if (v.length > VENDOR_CALL_MAX_CATEGORY_CHARS) {
      throw new Error(
        `category "${v.slice(0, 40)}…" is ${v.length} chars; max ${VENDOR_CALL_MAX_CATEGORY_CHARS}`
      );
    }
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  if (out.length > VENDOR_CALL_MAX_CATEGORIES) {
    throw new Error(`${out.length} categories; max ${VENDOR_CALL_MAX_CATEGORIES}`);
  }
  return out;
}

/**
 * Read a stored list. NULL / malformed / non-array → `[]`. Never throws: a bad
 * stored value must not take down the event page or the digest.
 */
export function parseVendorCategories(stored: string | null | undefined): string[] {
  if (!stored) return [];
  try {
    const v: unknown = JSON.parse(stored);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Serialize for storage. An empty list stores NULL ("no call published"), so
 * `[]` and "never set" cannot drift into two meanings.
 */
export function serializeVendorCategories(list: readonly string[]): string | null {
  return list.length ? JSON.stringify(list) : null;
}

export interface VendorCallRow {
  capacityStatus: string | null;
  closesAt: Date | null;
}

/**
 * Is this lane taking vendor applications right now?
 *
 * Capacity must be positively OPEN — the same allow-list as
 * `VENDOR_CAPACITY_OPEN_TO_APPLICATIONS` (OPE-794): UNKNOWN is not open, and a
 * status added later is excluded until someone decides otherwise. A closing
 * date passes on the calendar day in the venue zone (`hasCalendarDayPassed`),
 * so the convention a writer stored the time-of-day in cannot close the call
 * early. A NULL closing date is "not published", not "closed".
 */
export function isVendorCallCurrent(row: VendorCallRow, now: Date): boolean {
  if (row.capacityStatus !== "OPEN") return false;
  if (row.closesAt && hasCalendarDayPassed(row.closesAt, now)) return false;
  return true;
}
