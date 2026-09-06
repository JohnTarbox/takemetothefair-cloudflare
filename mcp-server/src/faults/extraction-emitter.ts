/**
 * OPE-463 — record an extraction fault, idempotently.
 *
 * Lives in `mcp-server/` because the only caller today is `update_event_status`,
 * an MCP tool. Deliberately NOT hoisted into a shared package yet: emitters 1
 * and 2 (`extract.unsupported_field`, `extract.fanout`) wait on OPE-465 and
 * OPE-378, and if either lands on the main-app side this moves to a package
 * then. Sharing a module before a second caller exists is how you get an
 * abstraction shaped around one use.
 *
 * ## Idempotency by ledger columns, never a side watermark
 *
 * The acceptance is explicit: *"Re-running the emitters files nothing new and
 * creates no duplicate rows (idempotency by ledger columns, no side
 * watermark)."* So recurrence is an UPSERT on the signature that bumps
 * `last_seen` and `count`, and the ledger row is the only state. A separate
 * "last processed at" marker would be a second source of truth that can drift
 * from the thing it claims to describe — and drift silently, because nothing
 * compares them.
 *
 * ## Emit, never auto-file
 *
 * Scope 5 of the ticket: *"Do NOT auto-file from this source yet. Emit and
 * accumulate only."* Nothing here writes an `ope_id` or calls the filing rail.
 * The reason is arithmetic rather than caution — this lane hard-fails on 50% of
 * submissions, so an unbounded emitter wired to auto-file would flood the
 * tracker on its first night.
 *
 * ⚠️ **A regression re-opens rather than duplicating.** A signature whose
 * `resolved_at` is set and which then recurs (`last_seen > resolved_at`) is the
 * CPI rail's regression shape. Inserting a second row for it would split one
 * fault's history in two and reset its recurrence count — so the same row is
 * re-opened and `resolved_at` cleared.
 */
import { eq, sql } from "drizzle-orm";
import { extractionFaults } from "../schema.js";
import type { Db } from "../db.js";

export interface EmitExtractionFaultInput {
  signature: string;
  source: string;
  familyId: string;
  detail?: string | null;
  now?: Date;
}

export type EmitOutcome = "created" | "recurred" | "reopened";

/**
 * Upsert one extraction fault.
 *
 * Never throws: this is telemetry attached to an action that already happened
 * (an operator rejected an event; the row is already REJECTED). Failing the
 * caller over a failed observation would turn a measurement into an outage.
 */
export async function emitExtractionFault(
  db: Db,
  input: EmitExtractionFaultInput
): Promise<EmitOutcome | null> {
  const now = input.now ?? new Date();
  try {
    const existing = await db
      .select({
        signature: extractionFaults.signature,
        resolvedAt: extractionFaults.resolvedAt,
      })
      .from(extractionFaults)
      .where(eq(extractionFaults.signature, input.signature))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(extractionFaults).values({
        signature: input.signature,
        source: input.source,
        familyId: input.familyId,
        detail: input.detail ?? null,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        // The canonical unadjudicated status (OPE-811). NOT 'open' — that is
        // the vocabulary agents write by hand, and both are fileable.
        status: "proposed",
        opeId: null,
        filedAt: null,
        resolvedAt: null,
        createdAt: now,
      });
      return "created";
    }

    const wasResolved = existing[0].resolvedAt != null;
    await db
      .update(extractionFaults)
      .set({
        lastSeen: now,
        count: sql`${extractionFaults.count} + 1`,
        detail: input.detail ?? null,
        // A resolved signature that recurs is a REGRESSION: re-open the same
        // row so its history and recurrence count stay whole.
        ...(wasResolved
          ? { status: "regressed" as const, resolvedAt: null, opeId: null, filedAt: null }
          : {}),
      })
      .where(eq(extractionFaults.signature, input.signature));

    return wasResolved ? "reopened" : "recurred";
  } catch {
    // Deliberately silent — see the note above.
    return null;
  }
}
