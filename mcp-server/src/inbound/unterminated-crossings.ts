/**
 * OPE-366 (R2) — the half that NOTICES.
 *
 * OPE-330 built the membrane-crossing ledger and it works: when work crosses a
 * boundary, a row appears. What was missing is anything that READS it. Ten of
 * twelve `email_to_ticket` crossings carried `destination_ref = NULL` and sat
 * in a table with no reader, no alarm, and no place in any inventory — the
 * evidence was in the database the whole time and only an external oracle
 * surfaced it.
 *
 * ## What "unterminated" means, and what it deliberately does NOT mean
 *
 * `destination_ref IS NULL` is the raw signal, but it was NOT safe to treat as
 * universal. Measured 2026-08-13, 8 of the 10 NULLs were `support-ack` rows —
 * and R1 (OPE-365) had already given those emails a real, durable destination:
 * a `support_obligations` row. The ledger simply could not record it, because
 * the workflow derived its destination solely from `resultingEventId`. Those
 * NULLs were a **sensor gap, not a dead-end**, and a detector built on the raw
 * signal would have alarmed forever on work that was correctly handed off.
 *
 * That sensor gap is fixed alongside this (`ref.supportObligation`), so from
 * here a NULL destination means what it says.
 *
 * ## Excluded crossing types — named, not silent
 *
 * - **`email_to_hold`**: excluded. Its NULL is BY DESIGN and documented at the
 *   write site — "the absent destination IS the signal that work stopped at a
 *   membrane". A hold is a legitimate resting state awaiting a human, with its
 *   own exit (`hold_to_resolve`), and the photo-intake hold queue (OPE-254)
 *   already owns that surface. Policing it here would double-report it.
 *
 * Everything else is policed. That direction is deliberate: a crossing type
 * added later is covered by DEFAULT rather than silently unwatched, which is
 * the failure mode this whole ticket family exists to kill. If a new type
 * legitimately has no destination, it gets added to the exclusion list above
 * with a reason — an explicit decision, not an omission.
 */
import { and, isNull, lt, ne, desc } from "drizzle-orm";
import { membraneCrossings } from "../schema.js";
import type { Db } from "../db.js";

/**
 * Hours a crossing may sit destination-less before it counts as a fault.
 *
 * The inbound workflow writes its crossing in the `mark-done` step, seconds
 * after the email lands — a crossing is never legitimately NULL "while
 * processing" for any meaningful window, because the row is only written once
 * processing has finished. So the threshold is not about in-flight work; it is
 * a margin against clock skew, Workflow retries (at-least-once, with backoff),
 * and a manual replay. Six hours is comfortably past all three and still well
 * inside a day, so a fault raised overnight is on the operator's desk in the
 * morning rather than a week later.
 */
export const UNTERMINATED_AGE_HOURS_DEFAULT = 6;

/** Crossing types whose NULL destination is legitimate. See the docblock. */
export const UNTERMINATED_EXCLUDED_TYPES = ["email_to_hold"] as const;

export interface UnterminatedCrossing {
  id: string;
  crossingType: string;
  sourceRef: string;
  notes: string | null;
  createdAt: Date;
}

export function ageHoursFrom(env: { UNTERMINATED_CROSSING_AGE_HOURS?: string }): number {
  const raw = Number(env.UNTERMINATED_CROSSING_AGE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : UNTERMINATED_AGE_HOURS_DEFAULT;
}

/**
 * Crossings that entered a membrane and never came out.
 *
 * Ordered newest-first: when this drives an alarm, the operator wants the thing
 * that just broke, not the oldest survivor.
 */
export async function findUnterminatedCrossings(
  db: Db,
  now: Date,
  opts: { ageHours?: number; limit?: number } = {}
): Promise<UnterminatedCrossing[]> {
  const ageHours = opts.ageHours ?? UNTERMINATED_AGE_HOURS_DEFAULT;
  const cutoff = new Date(now.getTime() - ageHours * 3600 * 1000);

  const rows = await db
    .select({
      id: membraneCrossings.id,
      crossingType: membraneCrossings.crossingType,
      sourceRef: membraneCrossings.sourceRef,
      notes: membraneCrossings.notes,
      createdAt: membraneCrossings.createdAt,
    })
    .from(membraneCrossings)
    .where(
      and(
        isNull(membraneCrossings.destinationRef),
        lt(membraneCrossings.createdAt, cutoff),
        // Single exclusion today; expressed as an AND-chain so adding a second
        // is a one-line change rather than a rewrite.
        ...UNTERMINATED_EXCLUDED_TYPES.map((t) => ne(membraneCrossings.crossingType, t))
      )
    )
    .orderBy(desc(membraneCrossings.createdAt))
    .limit(opts.limit ?? 100);

  return rows;
}

/** Count only — for the standing inventory line, which does not need the rows. */
export async function countUnterminatedCrossings(
  db: Db,
  now: Date,
  opts: { ageHours?: number } = {}
): Promise<number> {
  // Bounded by the same limit as the detail query so the two can never
  // disagree about "how many" in a way an operator would notice.
  const rows = await findUnterminatedCrossings(db, now, opts);
  return rows.length;
}
