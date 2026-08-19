/**
 * OPE-108 — idempotent D1 upsert for a parsed GSC milestone (see
 * gsc-milestone-email.ts for the parser). Dedupes on
 * `(metric, window_days, threshold)` and KEEPS the earliest row: Google can
 * re-send the same threshold with a later email date, and the milestone chart
 * wants one badge per threshold, not one per re-send. (The table's own unique
 * index includes `email_date`, so it wouldn't stop a re-send from duplicating —
 * this app-level dedupe does.)
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { gscMilestoneEmails } from "@/lib/db/schema";
import type { GscMilestone } from "./gsc-milestone-email";

export interface IngestMilestoneResult {
  /** true when a new row was written; false when an existing threshold matched. */
  inserted: boolean;
  /**
   * OPE-456 — true when an EXISTING row's `reached_date` was improved by this
   * call. Distinct from `inserted`, and reported because the old contract
   * ("inserted: false, kept the earliest row") gave a caller supplying better
   * information no way to tell it had been discarded.
   */
  corrected: boolean;
  /** Human-readable statement of what happened, for the tool response. */
  outcome: string;
  row: typeof gscMilestoneEmails.$inferSelect;
}

/**
 * OPE-456 — is `next` a better-sourced reached date than `current`?
 *
 * Only an ANCHORED parse — one read from the sentence that states the milestone
 * — may supersede anything. It may replace an absent date, or one whose
 * provenance is unknown (every row predating this column), or an unanchored
 * one, which on a forwarded email is the forward header's date.
 *
 * Nothing may supersede an anchored value. The asymmetry is the whole point:
 * "first write wins forever" made every ingest bug unfixable through the tool
 * that caused it, but "last write wins" would let a re-forward overwrite a good
 * date with the date of the re-forward.
 */
function supersedes(
  next: { date: string | null; source: string | null },
  current: { date: string | null; source: string | null }
): boolean {
  if (!next.date || next.source !== "anchored") return false;
  if (current.source === "anchored") return false;
  return current.date !== next.date || current.source !== "anchored";
}

export async function ingestGscMilestone(
  db: Database,
  m: GscMilestone,
  opts: { note?: string | null } = {}
): Promise<IngestMilestoneResult> {
  const existing = await db
    .select()
    .from(gscMilestoneEmails)
    .where(
      and(
        eq(gscMilestoneEmails.metric, m.metric),
        eq(gscMilestoneEmails.windowDays, m.windowDays),
        eq(gscMilestoneEmails.threshold, m.threshold)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const current = existing[0];
    const next = { date: m.reachedDate, source: m.reachedDateSource };

    if (supersedes(next, { date: current.reachedDate, source: current.reachedDateSource })) {
      const [updated] = await db
        .update(gscMilestoneEmails)
        .set({ reachedDate: next.date, reachedDateSource: "anchored" })
        .where(eq(gscMilestoneEmails.id, current.id))
        .returning();
      return {
        inserted: false,
        corrected: true,
        outcome:
          `Threshold already recorded; reached_date corrected ` +
          `${current.reachedDate ?? "NULL"} -> ${next.date} ` +
          `(was ${current.reachedDateSource ?? "unknown provenance"}, now anchored to the milestone sentence).`,
        row: updated ?? current,
      };
    }

    return {
      inserted: false,
      corrected: false,
      outcome:
        current.reachedDateSource === "anchored"
          ? "Threshold already recorded with an anchored reached_date; left unchanged."
          : "Threshold already recorded — kept the earliest row (idempotent). " +
            "Supply a body containing the milestone sentence to correct its date.",
      row: current,
    };
  }

  const rows = await db
    .insert(gscMilestoneEmails)
    .values({
      metric: m.metric,
      windowDays: m.windowDays,
      threshold: m.threshold,
      reachedDate: m.reachedDate,
      reachedDateSource: m.reachedDateSource,
      emailDate: m.emailDate,
      note: opts.note ?? null,
      // siteUrl + source fall back to their schema defaults.
    })
    .returning();

  return {
    inserted: true,
    corrected: false,
    outcome: `Inserted (reached_date ${m.reachedDate ?? "NULL"}, ${m.reachedDateSource ?? "no date"}).`,
    row: rows[0],
  };
}
