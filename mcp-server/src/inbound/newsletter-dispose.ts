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
import type { CheckDuplicateInput, CheckDuplicateResult } from "../duplicates/check-duplicate.js";
import type { NewsletterItem } from "./newsletter-itemize.js";

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
    if (dup.isDuplicate && dup.identifiesSameEvent) {
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
