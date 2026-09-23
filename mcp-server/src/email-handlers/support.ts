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
// OPE-1066 — the decision and the write moved to one shared place, because
// correction/claim_request/press acknowledge-and-defer too and this handler is
// no longer the only caller.
import { openObligationIfOwed } from "./open-obligation.js";
import type { HandlerFn, HandlerResult } from "./types.js";
import { ackKindForIntent } from "./ack-kind.js";

const SOURCE = "mcp:email-handler:support";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  // OPE-366 — the ref for the crossing ledger, so this handler's destination is
  // recorded instead of reading as a dead-end. Stays null when no obligation is
  // owed (suppressed sender, non-obligating decision) — which is a genuine
  // "crossed into nothing" and SHOULD look like one.
  const obligationRef = await openObligationIfOwed(env, getDb(env.DB), row, SOURCE);

  return {
    // OPE-1134 — from what the sender ASKED (a vendor_inquiry lands here too).
    replyKind: ackKindForIntent(row.classifiedIntent),
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
