/**
 * `support@` / `hello@` handler — general questions and contact-form
 * replacement. Sender gets a friendly auto-ack.
 *
 * OPE-365 (R1): this handler used to say "No DB writes" and mean it. That is
 * how Katie disappeared — classified support 0.90 on 2026-08-10, acked in six
 * seconds, marked 'replied', and no record anywhere that a human still owed her
 * an answer about a signup page she could not use on her phone. She was helped
 * only because hello@ forwards into John's Gmail and he happened to read it.
 *
 * It now opens a `support_obligations` row: a durable, drainable record of the
 * obligation the ack creates. The ack itself is unchanged (that is R3), and the
 * classifier is unchanged (out of scope). What changes is that acknowledging
 * someone now leaves a trace of the promise.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { supportObligations } from "../schema.js";
import { decideObligation, extractEmailAddress } from "@takemetothefair/utils";
import { isEmailSuppressed } from "../tools/admin-send-vendor-email.js";
import { logError } from "../logger.js";
// OPE-366 — the handler names its own crossing destination; see types.ts.
import { ref } from "../inbound/crossing-ledger.js";
import type { HandlerFn, HandlerResult } from "./types.js";

const SOURCE = "mcp:email-handler:support";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const db = getDb(env.DB);

  // OPE-366 — the ref for the crossing ledger, so this handler's destination is
  // recorded instead of reading as a dead-end. Stays null when no obligation is
  // owed (suppressed sender, non-obligating decision) — which is a genuine
  // "crossed into nothing" and SHOULD look like one.
  let obligationRef: string | null = null;

  try {
    const fromAddress = row.fromAddress ?? "";
    // Suppression is a DB question, so it is resolved here and passed into the
    // pure decision rather than being looked up inside it.
    const suppressed = fromAddress ? await isEmailSuppressed(db, fromAddress) : false;

    const decision = decideObligation({
      fromAddress,
      toAddress: row.toAddress ?? null,
      classifiedIntent: row.classifiedIntent ?? "support",
      classifiedConfidence: row.classifiedConfidence ?? null,
      suppressed,
    });

    if (decision.obligated) {
      await db
        .insert(supportObligations)
        .values({
          id: crypto.randomUUID(),
          inboundEmailId: row.id,
          fromAddress: extractEmailAddress(fromAddress),
          subject: row.subject ?? null,
          // Recorded, not consulted. Keeping it makes the old inversion
          // measurable: if obligations only ever open above some confidence,
          // that is visible in this column.
          classifiedConfidence: row.classifiedConfidence ?? null,
          openedAt: new Date(),
          status: "open",
        })
        // The inbound_email_id UNIQUE index makes a Workflow retry idempotent.
        // Workflows are at-least-once; without this a retried step would open a
        // second obligation for the same person and inflate the queue depth.
        .onConflictDoNothing();

      // Read the id back rather than reusing the one generated above: on a
      // Workflow retry the insert is a no-op and the row that EXISTS is the one
      // the ledger must point at. Using the freshly-minted uuid would write a
      // crossing whose destination does not resolve.
      const [obligation] = await db
        .select({ id: supportObligations.id })
        .from(supportObligations)
        .where(eq(supportObligations.inboundEmailId, row.id))
        .limit(1);
      if (obligation) obligationRef = ref.supportObligation(obligation.id);
    }
  } catch (error) {
    // Never fail the ack over bookkeeping. A customer receiving no
    // acknowledgement is a worse outcome than an obligation we have to
    // reconcile later — but the failure is logged loudly rather than swallowed,
    // because a silently missing obligation is the whole defect.
    await logError(env.DB, {
      level: "error",
      source: SOURCE,
      message: "[OPE-365] failed to open support obligation — customer may be untracked",
      error,
      context: { inboundEmailId: row.id, fromAddress: row.fromAddress },
    });
  }

  return {
    replyKind: "support-ack",
    replyParams: { subject: row.subject ?? "" },
    status: "replied",
    // OPE-366 — null here is meaningful, not missing: it says no obligation was
    // owed, so the crossing genuinely terminated nowhere.
    crossingDestinationRef: obligationRef,
  };
};

/** Exported for the backfill + tests: the obligation row for an inbound. */
export async function hasObligation(
  db: ReturnType<typeof getDb>,
  inboundEmailId: string
): Promise<boolean> {
  const [existing] = await db
    .select({ id: supportObligations.id })
    .from(supportObligations)
    .where(eq(supportObligations.inboundEmailId, inboundEmailId))
    .limit(1);
  return Boolean(existing);
}
