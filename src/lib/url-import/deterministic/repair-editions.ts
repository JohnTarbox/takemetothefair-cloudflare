/**
 * OPE-432 — restore the editions a flattened extraction dropped.
 *
 * `findPublishedEditions` reads what the organizer published. This decides
 * whether the extraction lost any of it, and rebuilds only what is missing.
 *
 * ## The rule
 *
 * Repair only when ALL of these hold:
 *
 *   1. the source publishes ≥2 distinct years of the same event;
 *   2. the candidates cover FEWER distinct years than the source does;
 *   3. every candidate names the same event.
 *
 * (3) is the one that keeps this safe. A directory page listing ten different
 * fairs also contains many dated ranges across several years, and cloning one
 * fair's details across another fair's dates would be a far worse defect than
 * the one being fixed — it would fabricate events rather than merely lose them.
 * So a page is only treated as multi-edition when the extraction itself already
 * concluded these are all the same event, which is exactly the state that
 * produced this ticket: five candidates, all "Martha's Vineyard Agricultural
 * Fair", all 2026 or undated.
 *
 * ## What a repaired edition asserts, and what it does not
 *
 * Dates come from the source table and nothing else — never from the current
 * year, never from a sibling candidate. Everything else (venue, description,
 * fees) is copied from the best-populated candidate, because an organizer
 * publishing a forward schedule is describing one recurring event.
 *
 * That copy is an inference, not a quotation, so a repaired edition carries no
 * time-of-day: hours are the field this codebase has already been burned on
 * (the MDI incident invented a plausible descending 10-5/10-4/10-3 against a
 * published flat 9-4), and "the 2026 gate hours probably hold in 2029" is
 * exactly that shape of guess. Dates are quoted; hours are dropped.
 */
import type { ExtractedEvent } from "../types";
import { findPublishedEditions } from "./edition-table";

/**
 * Loose name key — enough to tell "the same fair written twice" from "two
 * different fairs".
 *
 * Strips a trailing year so "…Fair 2026" and "…Fair 2027" compare equal, which
 * is the whole point: the model often DOES put the year in the name while
 * flattening the date.
 *
 * Deliberately not `createSlug`: this never reaches a slug column, and the #120
 * rule exists to stop hand-rolled slug generators, not string comparison keys.
 */
function sameEventKey(name: string | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b\d+(st|nd|rd|th)\b/g, " ")
    .replace(/\bannual\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Count of non-empty fields — a proxy for "which candidate did the model do best". */
function richness(e: ExtractedEvent): number {
  return Object.entries(e).filter(([k, v]) => {
    if (k.startsWith("_")) return false;
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }).length;
}

/** The calendar year of an ISO `YYYY-MM-DD`, or null when absent/unparseable. */
function yearOf(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(iso);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Rewrite a trailing year in the name, or append one when there is none, so a
 * repaired edition is not a name-identical twin of the candidate it came from.
 * Two rows called "Martha's Vineyard Agricultural Fair" a year apart is how the
 * ack came to report distinct editions as duplicates of each other.
 */
function nameForYear(name: string | null, year: number): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  const withYear = trimmed.replace(/\b(19|20)\d{2}\b\s*$/, "").trim();
  return `${withYear} ${year}`;
}

export interface RepairResult {
  events: ExtractedEvent[];
  /** Years rebuilt from the source table. Empty when nothing was repaired. */
  repairedYears: number[];
}

/**
 * Add back any edition the source publishes and the extraction lost.
 *
 * Returns the input untouched (and `repairedYears: []`) whenever the page is
 * not an unambiguous multi-edition table for a single event.
 */
export function repairFlattenedEditions(
  events: ExtractedEvent[],
  sourceText: string,
  makeId: (year: number) => string = (year) => `edition-${year}`
): RepairResult {
  if (!sourceText || events.length === 0) return { events, repairedYears: [] };

  const published = findPublishedEditions(sourceText);
  if (published.length < 2) return { events, repairedYears: [] };

  // (3) — every candidate must name the same event. An unnamed candidate is
  // not evidence of a second event, so it is ignored rather than counted.
  const keys = new Set(events.map((e) => sameEventKey(e.name)).filter((k) => k.length > 0));
  if (keys.size !== 1) return { events, repairedYears: [] };

  // (2) — did the extraction actually lose a year?
  const covered = new Set(events.map((e) => yearOf(e.startDate)).filter((y): y is number => !!y));
  const missing = published.filter((p) => !covered.has(p.year));
  if (missing.length === 0) return { events, repairedYears: [] };

  const template = [...events].sort((a, b) => richness(b) - richness(a))[0];

  const repaired = missing.map((edition) => ({
    ...template,
    _extractId: makeId(edition.year),
    _selected: true,
    name: nameForYear(template.name, edition.year),
    startDate: edition.startDate,
    endDate: edition.endDate,
    // Quoted from the source: dates. Inferred, and therefore dropped:
    // everything time-shaped. See the header.
    startTime: null,
    endTime: null,
    hoursVaryByDay: false,
    hoursNotes: null,
    specificDates: null,
    // A deadline for the 2026 edition says nothing about 2029's.
    applicationDeadline: null,
    applicationInstructions: null,
  }));

  return {
    events: [...events, ...repaired].sort((a, b) =>
      (a.startDate ?? "").localeCompare(b.startDate ?? "")
    ),
    repairedYears: missing.map((m) => m.year),
  };
}
