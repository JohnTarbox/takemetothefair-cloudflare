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
import type { VendorCapacityStatus } from "@takemetothefair/constants";
import {
  hasCalendarDayPassed,
  parseDateOnly,
  parseWallClockInVenueZone,
} from "@takemetothefair/datetime";
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

// ── Writing a route row (OPE-1512 / OPE-1513) ───────────────────────────

/** "YYYY-MM-DD" → that day at hh:mm:ss in the venue zone. Null on a bad date. */
export function venueInstant(day: string, hhmm: string, seconds = 0): Date | null {
  // parseDateOnly rejects calendar overflow ("2026-02-30"); the wall-clock
  // parser alone would roll it into March.
  if (!parseDateOnly(day)) return null;
  const d = parseWallClockInVenueZone(day, hhmm);
  return d ? new Date(d.getTime() + seconds * 1000) : null;
}
/** The OPE-750 `closes_at` convention: the closing day, 23:59:59 ET. */
export const closingInstant = (day: string) => venueInstant(day, "23:59", 59);
/** Opening is the start of the published day, 00:00 ET. */
export const openingInstant = (day: string) => venueInstant(day, "00:00");
/** As-of dates are calendar days; anchor them at noon ET so no zone shifts the day. */
export const asOfInstant = (day: string) => venueInstant(day, "12:00");

export interface ApplicationPatchInput {
  url?: string | null;
  contact_email?: string | null;
  notes?: string | null;
  opens_on?: string | null;
  closes_on?: string | null;
  capacity_status?: VendorCapacityStatus;
  capacity_as_of?: string | null;
  capacity_note?: string | null;
  categories_wanted?: string[] | null;
  categories_full?: string[] | null;
  categories_as_of?: string | null;
}

/** Column patch, camelCase Drizzle keys of `event_applications`. */
export interface ApplicationPatch {
  url?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  opensAt?: Date | null;
  closesAt?: Date | null;
  capacityStatus?: string;
  capacityAsOf?: Date | null;
  capacityNote?: string | null;
  categoriesWanted?: string | null;
  categoriesFull?: string | null;
  categoriesAsOf?: Date | null;
}

/**
 * Pure: write args → column patch. Shared by the admin MCP tool
 * (`upsert_event_application`) and the promoter portal (OPE-1513). Only keys the caller passed appear in the
 * patch, so an omitted field can never be written (and so never clobbered).
 *
 * The two `as_of` dates follow their claim: setting a capacity status other
 * than UNKNOWN stamps `capacity_as_of` (today unless given); UNKNOWN clears it,
 * per the column contract. Setting either category list stamps
 * `categories_as_of` the same way; when both lists end up empty it clears.
 */
export function buildApplicationPatch(
  input: ApplicationPatchInput,
  existing: { categoriesWanted: string | null; categoriesFull: string | null } | null,
  now: Date
): { patch: ApplicationPatch; problems: string[] } {
  const patch: ApplicationPatch = {};
  const problems: string[] = [];

  if (input.url !== undefined) patch.url = input.url;
  if (input.contact_email !== undefined) patch.contactEmail = input.contact_email;
  if (input.notes !== undefined) patch.notes = input.notes;

  const dateField = (
    v: string | null | undefined,
    name: string,
    conv: (d: string) => Date | null
  ): Date | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const d = conv(v);
    if (!d) problems.push(`${name}: "${v}" is not a real calendar date`);
    return d;
  };
  const opensAt = dateField(input.opens_on, "opens_on", openingInstant);
  if (opensAt !== undefined) patch.opensAt = opensAt;
  const closesAt = dateField(input.closes_on, "closes_on", closingInstant);
  if (closesAt !== undefined) patch.closesAt = closesAt;

  if (input.capacity_status !== undefined) {
    patch.capacityStatus = input.capacity_status;
    if (input.capacity_status === "UNKNOWN") {
      patch.capacityAsOf = null;
    } else {
      const asOf = dateField(input.capacity_as_of, "capacity_as_of", asOfInstant);
      patch.capacityAsOf = asOf ?? now;
    }
  } else if (input.capacity_as_of !== undefined) {
    const asOf = dateField(input.capacity_as_of, "capacity_as_of", asOfInstant);
    if (asOf !== undefined) patch.capacityAsOf = asOf;
  }
  if (input.capacity_note !== undefined) patch.capacityNote = input.capacity_note;

  const list = (v: string[] | null | undefined, name: string): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    try {
      return serializeVendorCategories(normalizeVendorCategories(v));
    } catch (e) {
      problems.push(`${name}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const wanted = list(input.categories_wanted, "categories_wanted");
  const full = list(input.categories_full, "categories_full");
  if (wanted !== undefined) patch.categoriesWanted = wanted;
  if (full !== undefined) patch.categoriesFull = full;

  if (wanted !== undefined || full !== undefined) {
    const finalWanted = wanted !== undefined ? wanted : (existing?.categoriesWanted ?? null);
    const finalFull = full !== undefined ? full : (existing?.categoriesFull ?? null);
    if (!finalWanted && !finalFull) {
      patch.categoriesAsOf = null;
    } else {
      const asOf = dateField(input.categories_as_of, "categories_as_of", asOfInstant);
      patch.categoriesAsOf = asOf ?? now;
    }
  } else if (input.categories_as_of !== undefined) {
    const asOf = dateField(input.categories_as_of, "categories_as_of", asOfInstant);
    if (asOf !== undefined) patch.categoriesAsOf = asOf;
  }

  return { patch, problems };
}
