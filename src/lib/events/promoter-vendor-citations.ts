/**
 * OPE-1680 — the promoter portal stores a vendor fee or application deadline
 * only together with a citation saying where it came from.
 *
 * Three routes write these fields from the organizer's own UI:
 *   - POST  /api/promoter/events                 (one-shot create)
 *   - POST  /api/promoter/events/draft           (wizard: create a DRAFT, then
 *                                                 update it on every later save)
 *   - PATCH /api/promoter/events/[id]/vendor-call (OPE-1513 vendor-call editor)
 *
 * The organizer is the source. So the citation is `user_submitted`, named after
 * the promoter, at a synthesized `submission://promoter-portal/<eventId>`: the
 * form has no source URL, and `source_url` is NOT NULL. That's the convention
 * the suggest-event route already uses (`submission://suggest-event/<id>`).
 *
 * A draft is saved many times. A re-save must not leave two ACTIVE citations
 * for one field, so writes go through `writeVendorCitationsSuperseding`, which
 * applies `update_event`'s rule: prior active citations for the same
 * (event, field, year IS NULL) bucket become `superseded`. A re-save that does
 * not change a stored value writes nothing (`changedVendorFields`).
 */
import { and, eq } from "drizzle-orm";
import { citationSupersedeScope, eventDataCitations } from "@/lib/db/schema";
import { buildSubmissionVendorCitations } from "@/lib/events/submission-vendor-citations";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";

type Db = ReturnType<typeof getCloudflareDb>;
type NewCitation = typeof eventDataCitations.$inferInsert;

export const PROMOTER_PORTAL_CHANNEL = "promoter-portal";

export interface PromoterVendorValues {
  eventId: string;
  promoterName: string | null | undefined;
  userId: string | null | undefined;
  /** Which route, for the notes text. */
  route: "events" | "draft" | "events/[id]/vendor-call";
  vendorFeeMin: { submitted: number | null | undefined; storedCents: number | null };
  vendorFeeMax: { submitted: number | null | undefined; storedCents: number | null };
  applicationDeadline: { submitted: string | null | undefined; stored: Date | null };
  now: Date;
}

export function buildPromoterVendorCitations(v: PromoterVendorValues): NewCitation[] {
  return buildSubmissionVendorCitations({
    eventId: v.eventId,
    sourceUrl: null,
    sourceName: v.promoterName ?? null,
    ingestionMethod: "promoter_portal",
    createdBy: v.userId,
    vendorFeeMin: v.vendorFeeMin,
    vendorFeeMax: v.vendorFeeMax,
    applicationDeadline: v.applicationDeadline,
    now: v.now,
    channel: PROMOTER_PORTAL_CHANNEL,
    notes: `Supplied by the organizer via the promoter portal (api/promoter/${v.route}).`,
  });
}

/**
 * Which of the three vendor fields a draft re-save actually changes. A field
 * counts only if the caller sent it AND the stored value differs from the row's
 * current value, so an autosave that repeats the same fee writes no citation.
 */
export function changedVendorFields(
  sent: (key: string) => boolean,
  next: {
    vendorFeeMinCents?: number | null;
    vendorFeeMaxCents?: number | null;
    applicationDeadline?: Date | null;
  },
  existing: {
    vendorFeeMinCents: number | null;
    vendorFeeMaxCents: number | null;
    applicationDeadline: Date | null;
  }
): { vendorFeeMin: boolean; vendorFeeMax: boolean; applicationDeadline: boolean } {
  const time = (d: Date | null | undefined) => (d ? d.getTime() : null);
  return {
    vendorFeeMin:
      sent("vendorFeeMin") && (next.vendorFeeMinCents ?? null) !== existing.vendorFeeMinCents,
    vendorFeeMax:
      sent("vendorFeeMax") && (next.vendorFeeMaxCents ?? null) !== existing.vendorFeeMaxCents,
    applicationDeadline:
      sent("applicationDeadline") &&
      time(next.applicationDeadline) !== time(existing.applicationDeadline),
  };
}

/**
 * Insert the rows, first marking any prior ACTIVE citation in each row's
 * (event, field, year IS NULL) bucket as `superseded`, the rule `update_event`
 * applies. Sequential statements, no `db.batch` (route test DBs lack it).
 */
export async function writeVendorCitationsSuperseding(db: Db, rows: NewCitation[]): Promise<void> {
  for (const row of rows) {
    await db
      .update(eventDataCitations)
      .set({ state: "superseded", updatedAt: row.createdAt ?? new Date() })
      .where(
        and(
          citationSupersedeScope(row.eventId, row.fieldName, null),
          eq(eventDataCitations.state, "active")
        )
      );
  }
  if (rows.length > 0) await db.insert(eventDataCitations).values(rows);
}

/**
 * Build and write the citations for what a promoter route just stored.
 * Best-effort, like the suggest-event route: the event row is already durable,
 * a failure is logged at error level, and the vendor-field-citations probe is
 * what notices a value left uncited.
 */
export async function citePromoterVendorFields(
  db: Db,
  values: PromoterVendorValues
): Promise<void> {
  const rows = buildPromoterVendorCitations(values);
  if (rows.length === 0) return;
  try {
    await writeVendorCitationsSuperseding(db, rows);
  } catch (err) {
    await logError(db, {
      source: `api/promoter/${values.route}:vendor-citations`,
      message: "vendor fee/deadline citation insert failed",
      error: err,
      context: { eventId: values.eventId, fields: rows.map((r) => r.fieldName) },
    }).catch(() => {});
  }
}
