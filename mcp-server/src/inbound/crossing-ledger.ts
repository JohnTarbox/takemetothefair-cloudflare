/**
 * OPE-330 (Demux D-4) — record a membrane crossing.
 *
 * Seven defects this summer shared one shape: work crossed a boundary and
 * nothing recorded it, so when the work stopped moving nobody could say where.
 * OPE-285's feedback sat 24h unseen. The Maynard poster reached a lane that
 * couldn't finish it. OPE-254's photos stranded at a hold.
 *
 * A crossing row turns "what happened to this email?" into one indexed query,
 * and — the part that matters more — makes a MISSING crossing detectable,
 * because every crossing is paired with a source row that exists. The probe
 * joins against that source rather than hunting for an absence.
 *
 * NEVER THROWS. A ledger that can break the pipeline it observes is worse than
 * no ledger: the failure mode becomes "the email didn't get processed" instead
 * of "we don't know what happened to the email". Every caller treats this as
 * fire-and-forget.
 */
import { membraneCrossings } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";

/** The transitions we currently record. Text in the DB — adding one must not
 *  need a migration — but typed here so a caller can't invent a variant
 *  spelling that silently splits the query results. */
export type CrossingType =
  | "email_to_ticket"
  | "email_to_hold"
  | "hold_to_resolve"
  | "review_to_rework"
  | "route_to_lane";

export type CrossingActor = "system" | "agent" | "human";

export interface CrossingInput {
  /** Where the work came from — `inbound_email:<id>`, `issue:OPE-330`, … */
  sourceRef: string;
  /** Where it went. Omit for a terminal hold; the NULL is the probe's signal. */
  destinationRef?: string | null;
  crossingType: CrossingType;
  actor?: CrossingActor;
  notes?: string | null;
}

export async function recordCrossing(db: Db, input: CrossingInput): Promise<void> {
  try {
    await db.insert(membraneCrossings).values({
      id: crypto.randomUUID(),
      sourceRef: input.sourceRef,
      destinationRef: input.destinationRef ?? null,
      crossingType: input.crossingType,
      actor: input.actor ?? "system",
      notes: input.notes ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    // Log and continue — see the NEVER THROWS note above.
    await logError(db, {
      level: "warn",
      source: "mcp:inbound:crossing-ledger",
      message: `failed to record ${input.crossingType} crossing for ${input.sourceRef}`,
      error: err,
    });
  }
}

/** Conventional ref builders, so `inbound_email:<id>` is spelled one way. */
export const ref = {
  inboundEmail: (id: string) => `inbound_email:${id}`,
  event: (id: string) => `event:${id}`,
  issue: (key: string) => `issue:${key}`,
  hold: (id: string) => `hold:${id}`,
  lane: (name: string) => `lane:${name}`,
};
