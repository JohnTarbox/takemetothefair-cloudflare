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
  row: typeof gscMilestoneEmails.$inferSelect;
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
    return { inserted: false, row: existing[0] };
  }

  const rows = await db
    .insert(gscMilestoneEmails)
    .values({
      metric: m.metric,
      windowDays: m.windowDays,
      threshold: m.threshold,
      reachedDate: m.reachedDate,
      emailDate: m.emailDate,
      note: opts.note ?? null,
      // siteUrl + source fall back to their schema defaults.
    })
    .returning();

  return { inserted: true, row: rows[0] };
}
