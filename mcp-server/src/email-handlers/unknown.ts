/**
 * Catch-all handler for any recipient address not matched by
 * email-intents.ts's INTENT_MAP. The entrypoint forwarded the original
 * to admin Gmail before workflow creation, so the admin has full
 * context. Sender gets nothing back — silent on purpose (prevents
 * reflective-spam vector if attackers email random@meetmeatthefair).
 *
 * Returns replyKind: null so the workflow's send-reply step skips
 * entirely.
 *
 * OPE-1066: it also opens a support obligation when the CLASSIFIER said
 * `unclear` — a person wrote in and we could not tell what they wanted, which
 * is the population most at risk of being dropped, not least. `unclear` has
 * been in ACK_TERMINATING_INTENTS since OPE-365 and this handler never asked;
 * it works today only because every `unclear` row so far arrived at hello@ with
 * low confidence and fell back to `intent='support'`, so support.ts handled it.
 * A confidently-classified `unclear` would route here and vanish — leaving
 * "forwarded to admin Gmail" as the only trace, which is exactly how Katie was
 * lost.
 *
 * Opening the row sends nothing, so the deliberate silence to the sender is
 * unchanged. A genuinely unknown address stays unobligating: `unknown` is not
 * in ACK_TERMINATING_INTENTS, and the decision reads the classifier's intent.
 */

import { getDb } from "../db.js";
import { openObligationIfOwed } from "./open-obligation.js";
import type { HandlerFn, HandlerResult } from "./types.js";

const SOURCE = "mcp:email-handler:unknown";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const obligationRef = await openObligationIfOwed(env, getDb(env.DB), row, SOURCE);

  return {
    replyKind: null,
    status: "forwarded",
    crossingDestinationRef: obligationRef,
  };
};
