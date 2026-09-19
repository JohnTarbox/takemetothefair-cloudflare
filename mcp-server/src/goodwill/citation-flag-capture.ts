/**
 * OPE-1065 — a verification pass that finds a LIVE field wrong produces a
 * countable work item, not only a sentence in `event_data_citations.notes`.
 *
 * The specimen: on 2026-09-17 a pass wrote citation 59944862 for the Harwich
 * Cranberry festival with the note "Our description repeats it — flagged, not
 * re-asserted" about a parking claim. Four minutes later a member of the public
 * asked about exactly that claim, and the page stayed wrong until a human
 * happened to read the note. Nothing reads a free-text column, so a finding
 * written there reaches a human only by luck.
 *
 * ## Why this is not a text match on `notes`
 *
 * Measured on prod 2026-09-19 before building: of the 48 active citations whose
 * notes carry flag language (`flagged`, `⚠`, `not re-asserted`, …), the large
 * majority are SOURCE-TRAP warnings about a CORRECT row ("the DACF calendar
 * entry is wrong, do not use it"). And the one live unresolved conflict found
 * in the sweep — NECT Great Pumpkin Festival, "DATE CONFLICT, UNRESOLVED" —
 * uses none of those words. A text trigger is wrong in both directions, so the
 * two triggers here are structural:
 *
 *   1. `cited_value_differs` — automatic. A citation for a known denormalized
 *      field, written with `update_event_column=false`, whose parsed value
 *      differs from the live column. The caller cited a source and chose not to
 *      apply it: by construction our live field disagrees with the source.
 *   2. `declared` — the `live_defect` argument on the citation tools themselves,
 *      so the finding is recorded IN THE SAME CALL that writes the citation,
 *      not by a second tool someone has to remember (the way `create_discrepancy`
 *      was skipped on the specimen).
 *
 * ## Where the row goes, and why it cannot drown
 *
 * `event_discrepancies` with `detected_by='citation_flag'`. The 2026-09-05
 * outreach triage found that queue unusable AS SCORED for promoter outreach;
 * these rows stay out of that problem three ways:
 *   - `outreach_candidate` is forced false at capture AND held false by the
 *     re-ranker (NEVER_OUTREACH_DETECTORS) — it is our error, not the promoter's.
 *   - both source keys are NULL, so resolving one never moves a
 *     `source_reliability` cell.
 *   - they are separable by detector: `list_event_discrepancies(detected_by=
 *     "citation_flag")` is the answer to "which live fields do we currently
 *     believe are wrong?", without grepping prose.
 *
 * ## One row per (event, field_class), fields appended
 *
 * `captureDiscrepancy` dedups on (event_id, field_class, detected_by) while
 * open. Several live fields can share a class (`vendor_fee_min` and
 * `vendor_fee_max` are both `price`), and a second flag must not vanish into
 * a `last_seen_at` touch — so a new FIELD on an open row is appended to its
 * notes, and only a repeat of the same field is treated as a re-observation.
 */

import { and, eq } from "drizzle-orm";
import { eventDiscrepancies } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";
import { captureDiscrepancy, type FieldClass } from "./capture.js";

export const LIVE_DEFECT_KINDS = ["contradicted", "unsupported", "stale"] as const;
export type LiveDefectKind = (typeof LIVE_DEFECT_KINDS)[number];

export type LiveDefectTrigger = "declared" | "cited_value_differs";

export interface CitationLiveDefectArgs {
  eventId: string;
  /** The citation that carries the evidence. Quoted in the row's notes. */
  citationId: string;
  /** The LIVE field believed wrong — may differ from the citation's field. */
  field: string;
  kind: LiveDefectKind;
  trigger: LiveDefectTrigger;
  /** What the public page shows now. */
  liveValue?: string | null;
  /** What the cited source says instead (null for `unsupported`). */
  sourceSays?: string | null;
  sourceUrl: string;
  reason: string;
  confidence?: number | null;
}

export type CitationLiveDefectOutcome = "created" | "appended" | "already_recorded" | "failed";

export interface CitationLiveDefectResult {
  outcome: CitationLiveDefectOutcome;
  discrepancy_id: string | null;
  field_class: FieldClass;
  trigger: LiveDefectTrigger;
}

/** Notes cap — the column is TEXT, but a row that grows without bound stops
 *  being readable; the field markers at the front are what a triager needs. */
const NOTES_MAX = 2000;

/**
 * Map a citation field name onto the discrepancy field classes. Citation field
 * names are free text, so this is by pattern; anything unrecognised is `other`
 * rather than being forced into a class that would mis-sort it.
 */
export function fieldClassForCitationField(field: string): FieldClass {
  const f = field.trim().toLowerCase();
  if (f === "name" || f === "event_name") return "name";
  if (f === "status" || f.includes("cancel") || f === "lifecycle") return "status";
  if (f === "existence") return "existence";
  if (f === "venue_id" || f === "venue" || f.includes("address") || f === "location") {
    return "venue";
  }
  if (/(price|fee|admission|cost|ticket)/.test(f)) return "price";
  if (/(hours|open_time|close_time|schedule|event_days)/.test(f)) return "hours";
  if (/(date|deadline)/.test(f)) return "date";
  return "other";
}

/** The per-field segment written into the row's notes. The leading `[field]`
 *  marker is what makes a repeat of the same field detectable. */
function noteSegment(args: CitationLiveDefectArgs): string {
  const marker = `[${args.field}]`;
  const said = args.sourceSays != null ? ` Source says: ${args.sourceSays}.` : "";
  const live = args.liveValue != null ? ` Live: ${args.liveValue}.` : "";
  return `${marker} ${args.kind} (${args.trigger}, citation ${args.citationId.slice(0, 8)}): ${args.reason}${live}${said}`;
}

function clampNotes(s: string): string {
  return s.length <= NOTES_MAX ? s : `${s.slice(0, NOTES_MAX - 1)}…`;
}

/**
 * Record one live-field defect found by a citation write. Never throws: a
 * failure is returned as `outcome: "failed"` AND logged at error, so the tool
 * response can say so — the caller must not read a failed emission as success.
 */
export async function captureCitationLiveDefect(
  db: Db,
  args: CitationLiveDefectArgs
): Promise<CitationLiveDefectResult> {
  const fieldClass = fieldClassForCitationField(args.field);
  const base = { field_class: fieldClass, trigger: args.trigger };
  const segment = noteSegment(args);

  try {
    const open = await db
      .select({ id: eventDiscrepancies.id, notes: eventDiscrepancies.notes })
      .from(eventDiscrepancies)
      .where(
        and(
          eq(eventDiscrepancies.eventId, args.eventId),
          eq(eventDiscrepancies.fieldClass, fieldClass),
          eq(eventDiscrepancies.detectedBy, "citation_flag"),
          eq(eventDiscrepancies.resolutionStatus, "open")
        )
      )
      .limit(1);

    if (open.length > 0) {
      const row = open[0];
      const existing = row.notes ?? "";
      const sameField = existing.includes(`[${args.field}] `);
      await db
        .update(eventDiscrepancies)
        .set(
          sameField
            ? { lastSeenAt: new Date() }
            : { lastSeenAt: new Date(), notes: clampNotes(`${existing}\n${segment}`) }
        )
        .where(eq(eventDiscrepancies.id, row.id));
      return {
        ...base,
        outcome: sameField ? "already_recorded" : "appended",
        discrepancy_id: row.id,
      };
    }

    const id = await captureDiscrepancy(db, {
      eventId: args.eventId,
      fieldClass,
      detectedBy: "citation_flag",
      authoritativeValue: args.liveValue ?? null,
      // Deliberately NULL: a source key here would make resolving the row a
      // reliability signal, and a citation flag is a statement about OUR row.
      authoritativeSourceKey: null,
      authoritativeSourceUrl: null,
      divergentValue: args.sourceSays ?? null,
      divergentSourceKey: null,
      divergentSourceUrl: args.sourceUrl,
      confidence: args.confidence ?? null,
      forceOutreachCandidate: false,
      notes: clampNotes(segment),
    });
    // captureDiscrepancy returns null both on failure (already logged) and on
    // an open same-tuple row created between our read and its insert.
    if (id === null) return { ...base, outcome: "failed", discrepancy_id: null };
    return { ...base, outcome: "created", discrepancy_id: id };
  } catch (err) {
    await logError(db, {
      source: "mcp:goodwill:citation-flag",
      message: `citation live-defect capture failed for event=${args.eventId} field=${args.field}`,
      error: err,
    });
    return { ...base, outcome: "failed", discrepancy_id: null };
  }
}
