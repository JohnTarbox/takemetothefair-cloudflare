/**
 * OPE-1680 — the suggest-event submit route stores a vendor fee or application
 * deadline only together with a citation saying where it came from.
 *
 * OPE-1673 put this rule on the two MCP writers. This route is the choke point
 * for every other submitter: the vendor portal's /vendor/suggest-event form,
 * and the MCP email paths that call `submitEvent` (six call sites, plus photo
 * intake and newsletter candidates). Only the multi-source email pipeline cited
 * these fields afterwards (`recordSourceCitations`), so most of those paths
 * stored a fee or deadline with nothing behind it.
 *
 * What the citation can honestly say: the SUBMITTER supplied this value in this
 * submission. That is `user_submitted`, the type the email pipeline and the
 * promoter import already use for the same kind of claim.
 *
 * - `source_url` is the submission's own `sourceUrl` when it has one. That's the
 *   same identity `recordSourceCitations` writes for a URL source, and that
 *   helper skips an existing active row for the same (event, field, url), so a
 *   later pipeline pass does not duplicate this row.
 * - With no `sourceUrl` (a vendor typing a fee they know), the submission
 *   itself is the source: a synthesized `submission://suggest-event/<eventId>`,
 *   the same convention as the pipeline's `email://…` identities. The column is
 *   NOT NULL.
 *
 * A row is written only for a value that is actually STORED, so a citation
 * never exists without the value it supports.
 */
import type { eventDataCitations } from "@/lib/db/schema";

type NewCitation = typeof eventDataCitations.$inferInsert;

export interface SubmissionVendorValues {
  eventId: string;
  /** The submission's `sourceUrl`, if any. */
  sourceUrl: string | null | undefined;
  sourceName: string | null | undefined;
  ingestionMethod: string;
  /** The signed-in submitter, when there is one. */
  createdBy: string | null | undefined;
  /** As submitted (dollars), alongside what the route stored (cents). */
  vendorFeeMin: { submitted: number | null | undefined; storedCents: number | null };
  vendorFeeMax: { submitted: number | null | undefined; storedCents: number | null };
  /** As submitted (YYYY-MM-DD), alongside what the route stored. */
  applicationDeadline: { submitted: string | null | undefined; stored: Date | null };
  now: Date;
  /**
   * Which writer this submission came through. Names the synthesized
   * `submission://<channel>/<eventId>` identity when there is no `sourceUrl`.
   * Default `suggest-event`. OPE-1680: the promoter portal passes
   * `promoter-portal`, so its citations stay distinguishable.
   */
  channel?: string;
  /** Overrides the default notes text. */
  notes?: string;
  /**
   * Overrides `user_submitted`. OPE-1680: the admin UI and URL import pass
   * `other` — an operator typing a value, or a page the import read, is not a
   * submitter's own claim.
   */
  sourceType?: NewCitation["sourceType"];
}

export function submissionCitationSourceUrl(
  eventId: string,
  sourceUrl?: string | null,
  channel = "suggest-event"
): string {
  const url = sourceUrl?.trim();
  return url ? url : `submission://${channel}/${eventId}`;
}

/** One citation row per vendor field the route stored. Empty when none. */
export function buildSubmissionVendorCitations(v: SubmissionVendorValues): NewCitation[] {
  const stored: Array<{ fieldName: string; value: string }> = [];
  if (v.vendorFeeMin.storedCents !== null && v.vendorFeeMin.submitted != null) {
    stored.push({ fieldName: "vendor_fee_min", value: String(v.vendorFeeMin.submitted) });
  }
  if (v.vendorFeeMax.storedCents !== null && v.vendorFeeMax.submitted != null) {
    stored.push({ fieldName: "vendor_fee_max", value: String(v.vendorFeeMax.submitted) });
  }
  if (v.applicationDeadline.stored !== null && v.applicationDeadline.submitted) {
    // Same value text update_event writes: the date as passed.
    stored.push({
      fieldName: "application_deadline",
      value: v.applicationDeadline.submitted.slice(0, 10),
    });
  }
  const sourceUrl = submissionCitationSourceUrl(v.eventId, v.sourceUrl, v.channel);
  const notes =
    v.notes ?? `Supplied by the submitter via suggest-event/submit (${v.ingestionMethod}).`;
  return stored.map((f) => ({
    id: crypto.randomUUID(),
    eventId: v.eventId,
    fieldName: f.fieldName,
    value: f.value,
    // null, as update_event writes when no `citation.year` is given.
    year: null,
    sourceUrl,
    sourceName: v.sourceName ?? null,
    sourceType: v.sourceType ?? ("user_submitted" as const),
    state: "active" as const,
    notes,
    createdBy: v.createdBy || null,
    createdAt: v.now,
  }));
}
