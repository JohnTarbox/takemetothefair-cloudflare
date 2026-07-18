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
import { initialCaptureScore } from "./queue-ranking.js";

const OUTREACH_CANDIDATE_THRESHOLD = 0.6;

/** field_class enum (mirrors the SQL column). */
export type FieldClass = "date" | "hours" | "venue" | "status" | "price" | "existence" | "name";

/** detected_by enum.
 *
 *  `holdout_sample` added GW1.3 (2026-06-03) — daily random ~1% sample
 *  of high-trust source events re-checked against the live source page
 *  to guard against silent drift (the CPI guardrail from the GW1 spec).
 *  Schema column has no CHECK constraint so the addition is TS-only.
 */
export type DetectedBy =
  | "ingest_addverify"
  | "stale_page_radar"
  | "self_consistency"
  | "holdout_sample"
  | "manual";

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
    const detectedAt = new Date();
    // OPE-245 — score at write time. Previously this insert set no
    // outreach_priority_score (defaulting NULL) and outreachCandidate=false, so
    // EVERY automated discrepancy (self_consistency / stale_page_radar /
    // ingest_addverify / holdout_sample all funnel through here) was unranked
    // from ship — the GW1d ranker existed but nothing on the capture path
    // called it. Neutral view-count/reliability priors keep this a single
    // INSERT; the batched rerank upgrades the score with real view counts.
    const initialScore = initialCaptureScore({
      fieldClass: args.fieldClass,
      confidence: args.confidence,
      detectedAt,
    });
    await db.insert(eventDiscrepancies).values({
      id,
      eventId: args.eventId,
      fieldClass: args.fieldClass,
      detectedBy: args.detectedBy,
      detectedAt,
      authoritativeValue: args.authoritativeValue ?? null,
      authoritativeSourceKey: args.authoritativeSourceKey ?? null,
      authoritativeSourceUrl: args.authoritativeSourceUrl ?? null,
      divergentValue: args.divergentValue ?? null,
      divergentSourceKey: args.divergentSourceKey ?? null,
      divergentSourceUrl: args.divergentSourceUrl ?? null,
      confidence: args.confidence ?? null,
      notes: args.notes ?? null,
      resolutionStatus: "open",
      outreachPriorityScore: initialScore,
      outreachCandidate: initialScore >= OUTREACH_CANDIDATE_THRESHOLD,
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
 * GW1.3 (2026-06-03) — emit a holdout_sample discrepancy when the daily
 * re-check of a high-trust source page surfaces a field-value divergence
 * from the stored event row.
 *
 * Unlike stale_page_radar (which leans on event_date_drift_findings as a
 * pre-computed input), the holdout-sampling cron re-runs the live fetch +
 * K7 deterministic+AI extract cascade against the source URL on each
 * sampled event, then calls this helper one field at a time when the
 * comparator finds a divergence. The authoritative side IS the source
 * being re-checked — its score gets credit/debit on the resolution path
 * (GW1c circularity guard handles this correctly).
 *
 * `confidence` defaults to 0.8: high-trust source means the
 * re-extraction is unlikely to be wrong, but lower than ingest_addverify
 * (0.85) because re-fetch noise (transient page state, intermediate
 * redirects) is a real failure mode here.
 */
export async function captureHoldoutSampleDiscrepancy(
  db: Db,
  args: {
    eventId: string;
    fieldClass: FieldClass;
    /** Stored value on the event row. */
    storedValue: string | null;
    /** Fresh re-extracted value from the same source URL. */
    refreshValue: string | null;
    /** The source URL being re-checked (== events.source_url). */
    sourceUrl: string | null;
    confidence?: number | null;
    notes?: string | null;
  }
): Promise<string | null> {
  return captureDiscrepancy(db, {
    eventId: args.eventId,
    fieldClass: args.fieldClass,
    detectedBy: "holdout_sample",
    // The source we're re-checking IS the authoritative side — its
    // currently-stored value on the event row is what we trust by
    // default, and the divergent value is what the live re-extract
    // turned up. If the source page has drifted (was modified after
    // ingest), the divergent value is what would have come in had the
    // event been re-ingested today.
    authoritativeValue: args.storedValue,
    authoritativeSourceKey: safeHost(args.sourceUrl),
    authoritativeSourceUrl: args.sourceUrl ?? null,
    divergentValue: args.refreshValue,
    divergentSourceKey: safeHost(args.sourceUrl),
    divergentSourceUrl: args.sourceUrl ?? null,
    confidence: args.confidence ?? 0.8,
    notes: args.notes ?? null,
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
