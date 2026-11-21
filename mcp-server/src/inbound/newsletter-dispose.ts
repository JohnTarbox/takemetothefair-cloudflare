/**
 * OPE-1285 — decide what each newsletter item means for the events we hold.
 *
 *   matched       the shared matcher (findDuplicate, via the main app) names an
 *                 event and the newsletter's dates agree with it → corroborating
 *                 citations carrying the excerpt. Never touches the event.
 *   discrepancy   matched, but the dates disagree → an `event_discrepancies`
 *                 row naming both values, and NO corroborating citation.
 *   unmatched     no event of ours → recorded with what a candidate would be.
 *                 Nothing is created HERE: creation is its own step
 *                 (newsletter-candidates.ts, OPE-1286), runs only once the
 *                 lane owns the email (never beside the submit pipeline, or
 *                 two writers would race), and records its outcome on the item.
 *   skipped       unmatched AND either yearless or already past — a yearless
 *                 date in a bulletin is a workshop list, a TV slot, a sale.
 *
 * Matching uses the ONE dedup implementation (CLAUDE.md, "Dedup match key"),
 * not "this promoter's events": measured on the acceptance specimens, Maine
 * Made's featured event belongs to Maine Crafts Association, and New England
 * Made's newsletter comes from a sender that attributes to no promoter at all.
 */
import { levenshteinSimilarity, normalizeName } from "@takemetothefair/utils";
import type { CheckDuplicateInput, CheckDuplicateResult } from "../duplicates/check-duplicate.js";
import type { NewsletterItem } from "./newsletter-itemize.js";

/**
 * OPE-1696 — words that say what KIND of event something is, not WHICH one.
 * Two shows in one town share these by construction, so they carry no identity.
 */
const GENERIC_EVENT_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "annual",
  "day",
  "days",
  "weekend",
  "event",
  "events",
  "fair",
  "fairs",
  "festival",
  "fest",
  "show",
  "shows",
  "market",
  "markets",
  "farmers",
  "craft",
  "crafts",
  "expo",
  "sale",
  "bazaar",
]);

function distinctiveWords(name: string, townWords: Set<string>): Set<string> {
  return new Set(
    normalizeName(name)
      .split(" ")
      .filter((w) => w && !GENERIC_EVENT_WORDS.has(w) && !townWords.has(w) && !/^\d+$/.test(w))
  );
}

/**
 * OPE-1696 — does a newsletter item's name plausibly name the event a
 * `city_state_date` hit returned?
 *
 * That stage of `findDuplicate` is name-blind: any event in the same town within
 * ±7 days. For one submitted event that is a fair signal, and the submit lane
 * already rates it MEDIUM (`classifyDedupTier`). A newsletter is a digest of
 * MANY events in ONE town, so the town is the one thing every item shares —
 * measured on prod 2026-11-21, both dated items of the Downtown Bangor
 * newsletter bound to "Bangor Sunday Farmers Market — 2026-10-18".
 *
 * Affinity, any of: the normalized names are near-identical (Levenshtein ≥
 * 0.85, the shared matcher's own name threshold); or at least half the
 * shorter name's distinctive words — not the town, not "fair"/"show", not
 * numbers — appear in the other. The real NEM specimen ("New England Made
 * Autumn Show 2026" ↔ "New England Made Giftware & Specialty Food Show -
 * Autumn") passes on {new, england, made, autumn}; "Downtown Bangor Trick or
 * Treat" ↔ the farmers market shares only the town.
 */
export function newsletterNameAffinity(
  itemName: string,
  eventName: string,
  town: string | null
): boolean {
  const a = normalizeName(itemName);
  const b = normalizeName(eventName);
  if (!a || !b) return false;
  if (levenshteinSimilarity(a, b, 0.85) >= 0.85) return true;
  const townWords = new Set(town ? normalizeName(town).split(" ").filter(Boolean) : []);
  const wa = distinctiveWords(itemName, townWords);
  const wb = distinctiveWords(eventName, townWords);
  const shorter = wa.size <= wb.size ? wa : wb;
  const longer = shorter === wa ? wb : wa;
  if (shorter.size === 0) return false;
  let shared = 0;
  for (const w of shorter) if (longer.has(w)) shared++;
  return shared > 0 && shared * 2 >= shorter.size;
}

/**
 * OPE-1286 — the outcome of trying to turn one `unmatched` item into a PENDING
 * event. `exists` is the submit lane's HIGH dedup tier, including a prior human
 * adjudication (OPE-450): no row. `refused` is the OPE-1253 floor.
 */
export type CandidateOutcome =
  | {
      outcome: "created";
      eventId: string;
      routed: "created" | "occurrence";
      possibleDuplicateOf: string | null;
      citedFields: string[];
    }
  | { outcome: "occurrence-exists"; eventId: string }
  | { outcome: "exists"; eventId: string | null; matchType: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed"; error: string };

export type Disposition =
  | { kind: "matched"; eventId: string; matchType: string; citedFields: string[] }
  | {
      kind: "discrepancy";
      eventId: string;
      matchType: string;
      stored: { start: string; end: string | null };
      newsletter: { start: string; end: string | null };
    }
  | {
      kind: "unmatched";
      promoterId: string | null;
      /**
       * OPE-1286 — what the lane did with it once switched over. Absent means
       * not yet attempted (shadow mode, or a step that has not reached it):
       * the candidate step skips any item that already carries one, so a retry
       * never creates twice.
       */
      candidate?: CandidateOutcome;
    }
  | { kind: "skipped"; reason: "no-year" | "past" };

export interface DisposedItem extends NewsletterItem {
  disposition: Disposition;
}

export interface DisposeDeps {
  checkDuplicate: (input: CheckDuplicateInput) => Promise<CheckDuplicateResult>;
  /** Stored dates of an event, YYYY-MM-DD (UTC), or null if the row is gone. */
  loadEventDates: (eventId: string) => Promise<{ start: string; end: string | null } | null>;
  writeCitations: (args: {
    eventId: string;
    fields: { fieldName: "start_date" | "end_date"; value: string }[];
    excerpt: string;
  }) => Promise<number>;
  writeDiscrepancy: (args: {
    eventId: string;
    stored: string;
    newsletter: string;
  }) => Promise<void>;
}

const range = (start: string, end: string | null) =>
  end && end !== start ? `${start} – ${end}` : start;

export async function disposeItems(
  items: NewsletterItem[],
  ctx: { promoterId: string | null; receivedAt: Date },
  deps: DisposeDeps
): Promise<DisposedItem[]> {
  const out: DisposedItem[] = [];
  const today = ctx.receivedAt.toISOString().slice(0, 10);
  for (const item of items) {
    const dup = await deps.checkDuplicate({
      name: item.name,
      startDate: item.startDate,
      venueName: item.venue,
      venueCity: item.city,
      venueState: item.state,
    });
    // `series_url` only proves two rows share a listing page (OPE-454).
    // OPE-1696: a name-blind same-town hit is that event only if the names agree;
    // otherwise the item is treated as unmatched (the candidate step's own dedup
    // then rates the same hit MEDIUM and stages it for operator triage).
    const sameEvent =
      dup.isDuplicate &&
      dup.identifiesSameEvent &&
      (dup.matchType !== "city_state_date" ||
        newsletterNameAffinity(item.name, dup.existingEvent.name, item.city));
    if (dup.isDuplicate && sameEvent) {
      const eventId = dup.existingEvent.id;
      const stored = await deps.loadEventDates(eventId);
      if (stored) {
        // An item with no end date agrees with any stored end date.
        const agrees =
          stored.start === item.startDate && (item.endDate === null || item.endDate === stored.end);
        if (!agrees) {
          await deps.writeDiscrepancy({
            eventId,
            stored: range(stored.start, stored.end),
            newsletter: range(item.startDate, item.endDate),
          });
          out.push({
            ...item,
            disposition: {
              kind: "discrepancy",
              eventId,
              matchType: dup.matchType,
              stored,
              newsletter: { start: item.startDate, end: item.endDate },
            },
          });
          continue;
        }
        // Only a year the newsletter actually printed is citable (OPE-457).
        const fields: { fieldName: "start_date" | "end_date"; value: string }[] = item.yearExplicit
          ? [
              { fieldName: "start_date", value: item.startDate },
              ...(item.endDate ? [{ fieldName: "end_date" as const, value: item.endDate }] : []),
            ]
          : [];
        if (fields.length > 0)
          await deps.writeCitations({ eventId, fields, excerpt: item.excerpt });
        out.push({
          ...item,
          disposition: {
            kind: "matched",
            eventId,
            matchType: dup.matchType,
            citedFields: fields.map((f) => f.fieldName),
          },
        });
        continue;
      }
    }
    if (!item.yearExplicit) {
      out.push({ ...item, disposition: { kind: "skipped", reason: "no-year" } });
    } else if ((item.endDate ?? item.startDate) < today) {
      out.push({ ...item, disposition: { kind: "skipped", reason: "past" } });
    } else {
      out.push({ ...item, disposition: { kind: "unmatched", promoterId: ctx.promoterId } });
    }
  }
  return out;
}
