/**
 * OPE-1066 — opening a support obligation, in ONE place.
 *
 * This logic lived inline in `support.ts`, which was correct while `support@` /
 * `hello@` was the only lane that acknowledged-and-deferred. It is not the only
 * one: `correction`, `claim_request` and `press` dispatch to their own handlers,
 * and those handlers acknowledge the sender without recording that anyone still
 * owes them an answer.
 *
 * Widening `ACK_TERMINATING_INTENTS` alone would not have fixed that, and the
 * production data says so precisely. `inbound_emails` records both the intent
 * that dispatched (`intent`) and what the classifier said (`classified_intent`):
 *
 *   - a `correction` at confidence 0.90 gets `routing_source='classifier_override'`
 *     and dispatches to `correction.ts`, which never asked this question;
 *   - a `correction` at confidence 0.82 fell back to `intent='support'`, so
 *     `support.ts` DID ask it — and was refused, because `correction` was not on
 *     the allow-list.
 *
 * One real row of each shape, three weeks apart. Each half of the fix is
 * necessary and neither is sufficient, so the decision and the write are
 * extracted together rather than copied into two more handlers — three copies of
 * a rule is how the fourth lane gets forgotten.
 */

import { eq } from "drizzle-orm";
import { supportObligations } from "../schema.js";
import { decideObligation, extractEmailAddress } from "@takemetothefair/utils";
import { isEmailSuppressed } from "../tools/admin-send-vendor-email.js";
import { logError } from "../logger.js";
import { ref } from "../inbound/crossing-ledger.js";
import type { InboundEmail } from "@takemetothefair/db-schema";

/**
 * Open a `support_obligations` row when this inbound owes someone a human reply.
 *
 * Returns the crossing-ledger ref for the obligation, or `null` when none is
 * owed. `null` is meaningful rather than missing: it says the crossing genuinely
 * terminated nowhere (system sender, unsubscribed, or an intent that resolves
 * itself rather than deferring).
 *
 * Never throws. A customer receiving no acknowledgement is worse than an
 * obligation we reconcile later — but the failure is logged loudly, because a
 * silently missing obligation is the entire defect this exists to prevent.
 */
export async function openObligationIfOwed(
  env: { DB: D1Database },
  db: ReturnType<typeof import("../db.js").getDb>,
  row: InboundEmail,
  source: string,
  /** OPE-985 B — the caller knows a human is owed regardless of the classifier. */
  opts: { forceOwed?: boolean } = {}
): Promise<string | null> {
  try {
    const fromAddress = row.fromAddress ?? "";
    // Suppression is a DB question, so it is resolved here and passed into the
    // pure decision rather than being looked up inside it.
    const suppressed = fromAddress ? await isEmailSuppressed(db, fromAddress) : false;

    const decision = decideObligation({
      fromAddress,
      forceOwed: opts.forceOwed,
      toAddress: row.toAddress ?? null,
      // The CLASSIFIER's intent, not the intent that dispatched here. They differ
      // on exactly the rows this ticket is about, and the classifier's is the one
      // that describes what the sender actually wants.
      classifiedIntent: row.classifiedIntent ?? null,
      classifiedConfidence: row.classifiedConfidence ?? null,
      suppressed,
    });

    if (!decision.obligated) return null;

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
    return obligation ? ref.supportObligation(obligation.id) : null;
  } catch (error) {
    await logError(env.DB, {
      level: "error",
      source,
      message: "[OPE-365/1066] failed to open support obligation — customer may be untracked",
      error,
      context: { inboundEmailId: row.id, fromAddress: row.fromAddress },
    });
    return null;
  }
}
