/**
 * OPE-1680 — the admin writers store a vendor fee or application deadline only
 * together with a citation saying where it came from.
 *
 * Three admin routes write these fields:
 *   - POST  /api/admin/events          (admin "new event" form)
 *   - PATCH /api/admin/events/[id]     (admin edit form)
 *   - POST  /api/admin/import-url      (URL import: AI / deterministic extraction
 *                                       from a page, reviewed in the form)
 *
 * What each citation can honestly say:
 *   - Admin form: an operator typed the value. There is no evidence that it was
 *     read from the event's `source_url`, so citing that URL would overclaim.
 *     The source is the admin edit itself: `submission://admin-ui/<eventId>`,
 *     `source_type = other`, `created_by` = the admin.
 *   - URL import: the value was extracted from the imported page, then shown to
 *     the admin to confirm or correct. `source_url` = that page,
 *     `source_type = other` (the import does not know what kind of page it is).
 *
 * Writes go through `writeVendorCitationsSuperseding` (`update_event`'s rule),
 * and the edit path writes only for fields whose stored value actually changed
 * (`changedVendorFields`). Best-effort, like the other slices: the event row is
 * already durable, a failure is logged at error level, and the
 * vendor-field-citations probe is what notices a value left uncited.
 */
import { buildSubmissionVendorCitations } from "@/lib/events/submission-vendor-citations";
import { writeVendorCitationsSuperseding } from "@/lib/events/promoter-vendor-citations";
import type { getCloudflareDb } from "@/lib/cloudflare";
import type { eventDataCitations } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

type Db = ReturnType<typeof getCloudflareDb>;
type NewCitation = typeof eventDataCitations.$inferInsert;

export const ADMIN_UI_CHANNEL = "admin-ui";

export type AdminVendorWriter = "admin-create" | "admin-edit" | "import-url";

export interface AdminVendorValues {
  eventId: string;
  writer: AdminVendorWriter;
  /** The admin who saved. */
  userId: string | null | undefined;
  /** URL import only: the page the values were extracted from. */
  importedUrl?: string | null;
  /** URL import only: the source's display name, if known. */
  sourceName?: string | null;
  vendorFeeMin: { submitted: number | null | undefined; storedCents: number | null };
  vendorFeeMax: { submitted: number | null | undefined; storedCents: number | null };
  applicationDeadline: { submitted: string | null | undefined; stored: Date | null };
  now: Date;
}

const NOTES: Record<AdminVendorWriter, string> = {
  "admin-create": "Entered by an admin in the admin event form (api/admin/events POST).",
  "admin-edit": "Entered by an admin in the admin event form (api/admin/events/[id] PATCH).",
  "import-url":
    "Extracted from source_url by the admin URL import, then confirmed or corrected by the admin (api/admin/import-url).",
};

export function buildAdminVendorCitations(v: AdminVendorValues): NewCitation[] {
  const fromPage = v.writer === "import-url" ? v.importedUrl?.trim() || null : null;
  return buildSubmissionVendorCitations({
    eventId: v.eventId,
    // Only URL import has a real source page. The admin form never cites the
    // event's own source_url (see the header).
    sourceUrl: fromPage,
    sourceName: fromPage ? (v.sourceName ?? null) : null,
    ingestionMethod: v.writer,
    createdBy: v.userId,
    vendorFeeMin: v.vendorFeeMin,
    vendorFeeMax: v.vendorFeeMax,
    applicationDeadline: v.applicationDeadline,
    now: v.now,
    channel: ADMIN_UI_CHANNEL,
    notes: NOTES[v.writer],
    sourceType: "other",
  });
}

/** Build and write the citations for what an admin route just stored. Best-effort. */
export async function citeAdminVendorFields(db: Db, values: AdminVendorValues): Promise<void> {
  const rows = buildAdminVendorCitations(values);
  if (rows.length === 0) return;
  try {
    await writeVendorCitationsSuperseding(db, rows);
  } catch (err) {
    await logError(db, {
      source: `api/admin/${values.writer}:vendor-citations`,
      message: "vendor fee/deadline citation insert failed",
      error: err,
      context: { eventId: values.eventId, fields: rows.map((r) => r.fieldName) },
    }).catch(() => {});
  }
}
