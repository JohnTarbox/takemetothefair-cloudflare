/**
 * Shared discrepancy-capture helpers for GW1b.
 *
 * Each capture path writes one `event_discrepancies` row tagged with
 * the `detected_by` source. All helpers are idempotent within a sane
 * window — re-running today's cron should NOT double-insert rows for
 * the same (event_id, field_class, detected_by) tuple within the same
 * day. We enforce that via an existence check before INSERT (cheaper
 * than a unique index, which would also need a stable composite key
 * that doesn't yet exist on the table).
 *
 * Helpers never throw. Failures are logged and the discrepancy is
 * dropped — the cron caller must remain alive for the rest of its
 * Promise.all siblings.
 */

import { and, eq, gte } from "drizzle-orm";
import { eventDiscrepancies } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";

/** field_class enum (mirrors the SQL column). */
export type FieldClass = "date" | "hours" | "venue" | "status" | "price" | "existence" | "name";

/** detected_by enum. */
export type DetectedBy = "ingest_addverify" | "stale_page_radar" | "self_consistency" | "manual";

export interface CaptureDiscrepancyArgs {
  eventId: string;
  fieldClass: FieldClass;
  detectedBy: DetectedBy;
  /** The value currently stored on the event (the "what we think is right"). */
  authoritativeValue?: string | null;
  /** lowercased + www-stripped events.source_domain. NULL on self_consistency
   *  rows that don't have an external source — the event itself is the source. */
  authoritativeSourceKey?: string | null;
  authoritativeSourceUrl?: string | null;
  /** The other source's claim. For self_consistency, the hint of what the
   *  field would be if the inconsistency were corrected. */
  divergentValue?: string | null;
  divergentSourceKey?: string | null;
  divergentSourceUrl?: string | null;
  /** 0..1 — confidence this is a real divergence. NULL ⇒ detector doesn't
   *  compute one. */
  confidence?: number | null;
  /** Short human-readable explanation. Used by /admin/data-health and as
   *  the audit trail when the row is resolved. */
  notes?: string | null;
}

const ONE_DAY_SECS = 24 * 60 * 60;

/**
 * Write one discrepancy row, idempotent within ~24h on
 * (event_id, field_class, detected_by). The dedupe window prevents the
 * daily cron from accumulating identical rows on every re-run.
 *
 * Returns the inserted row id, or `null` when a same-tuple row already
 * exists within the window or the write failed.
 */
export async function captureDiscrepancy(
  db: Db,
  args: CaptureDiscrepancyArgs
): Promise<string | null> {
  try {
    const recencyCutoff = new Date(Date.now() - ONE_DAY_SECS * 1000);
    const existing = await db
      .select({ id: eventDiscrepancies.id })
      .from(eventDiscrepancies)
      .where(
        and(
          eq(eventDiscrepancies.eventId, args.eventId),
          eq(eventDiscrepancies.fieldClass, args.fieldClass),
          eq(eventDiscrepancies.detectedBy, args.detectedBy),
          gte(eventDiscrepancies.detectedAt, recencyCutoff)
        )
      )
      .limit(1);
    if (existing.length > 0) return null;

    const id = crypto.randomUUID();
    await db.insert(eventDiscrepancies).values({
      id,
      eventId: args.eventId,
      fieldClass: args.fieldClass,
      detectedBy: args.detectedBy,
      detectedAt: new Date(),
      authoritativeValue: args.authoritativeValue ?? null,
      authoritativeSourceKey: args.authoritativeSourceKey ?? null,
      authoritativeSourceUrl: args.authoritativeSourceUrl ?? null,
      divergentValue: args.divergentValue ?? null,
      divergentSourceKey: args.divergentSourceKey ?? null,
      divergentSourceUrl: args.divergentSourceUrl ?? null,
      confidence: args.confidence ?? null,
      notes: args.notes ?? null,
      resolutionStatus: "open",
      outreachCandidate: false,
    });
    return id;
  } catch (err) {
    await logError(db, {
      source: "mcp:goodwill:capture",
      message: `captureDiscrepancy failed for event=${args.eventId} field=${args.fieldClass} via=${args.detectedBy}`,
      error: err,
    });
    return null;
  }
}

/**
 * Map an `evaluateGates` reason code to a discrepancy `field_class`.
 * Centralized so the GW1b self-consistency cron and any future caller
 * agree on the taxonomy. Returns `null` for reason codes that don't
 * map to a single field (e.g. `source_tier_3_aggregator` is a source-
 * reliability signal, not a discrepancy on the event itself).
 */
export function gateReasonToFieldClass(reason: string): FieldClass | null {
  if (reason.startsWith("source_tier_")) return null;
  if (reason.startsWith("source_tabular_")) return "existence";

  // Date-family reasons — anything mentioning start/end/duration/deadline
  // resolves to the `date` field class.
  if (
    reason.startsWith("start_date_") ||
    reason.startsWith("end_date_") ||
    reason.startsWith("duration_") ||
    reason.startsWith("start_equals_") ||
    reason.startsWith("start_too_") ||
    reason === "start_equals_deadline" ||
    reason === "end_date_in_past"
  ) {
    return "date";
  }

  // Name-family reasons emitted by nameMatchesAdminFlag — admin-flag
  // patterns like "Call for Vendors" that suggest the title isn't yet
  // a real event title.
  if (reason.startsWith("name_") || reason.includes("admin_flag")) return "name";

  // Default: best-effort `existence` (the row's continued admission is
  // questionable), so the discrepancy queue still surfaces it for
  // operator triage even if the taxonomy is wrong.
  return "existence";
}

/**
 * Lowercased, www-stripped host from a URL. NULL on parse failure.
 * Matches the convention used everywhere else in the codebase for
 * `events.source_domain`-keyed lookups.
 */
export function safeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Convenience overload: emit a self_consistency discrepancy from an
 * `evaluateGates` reason. The authoritative source is the event row
 * itself (no external source); the divergent value is the reason code.
 */
export async function captureSelfConsistencyDiscrepancy(
  db: Db,
  args: {
    eventId: string;
    reason: string;
    sourceUrl: string | null;
    /** Snapshot of the authoritative value for the field, e.g. "2026-06-15"
     *  for a `start_date_*` reason. Helps operator triage without a JOIN. */
    authoritativeValue?: string | null;
    confidence?: number | null;
  }
): Promise<string | null> {
  const fieldClass = gateReasonToFieldClass(args.reason);
  if (!fieldClass) return null;

  return captureDiscrepancy(db, {
    eventId: args.eventId,
    fieldClass,
    detectedBy: "self_consistency",
    authoritativeValue: args.authoritativeValue ?? null,
    authoritativeSourceKey: safeHost(args.sourceUrl),
    authoritativeSourceUrl: args.sourceUrl ?? null,
    divergentValue: args.reason,
    divergentSourceKey: null,
    divergentSourceUrl: null,
    confidence: args.confidence ?? 0.9,
    notes: `evaluateGates reason: ${args.reason}`,
  });
}

/**
 * Convenience overload: emit a stale_page_radar discrepancy from an
 * unresolved event_date_drift_findings row. The authoritative value
 * is the row's stored start_date; the divergent value is the source's
 * fresh canonical date.
 */
export async function captureStalePageDiscrepancy(
  db: Db,
  args: {
    eventId: string;
    storedStartDate: Date;
    canonicalStartDate: Date | null;
    canonicalUrl: string | null;
    driftDays: number;
  }
): Promise<string | null> {
  const conf = Math.min(1, Math.abs(args.driftDays) / 30);
  return captureDiscrepancy(db, {
    eventId: args.eventId,
    fieldClass: "date",
    detectedBy: "stale_page_radar",
    authoritativeValue: args.storedStartDate.toISOString().slice(0, 10),
    authoritativeSourceKey: null, // we trust the event row's stored date a priori
    authoritativeSourceUrl: null,
    divergentValue: args.canonicalStartDate?.toISOString().slice(0, 10) ?? null,
    divergentSourceKey: safeHost(args.canonicalUrl),
    divergentSourceUrl: args.canonicalUrl,
    confidence: conf,
    notes: `drift ${args.driftDays}d between stored start_date and source's canonical date`,
  });
}
