/**
 * `press@` handler — media inquiries. The entrypoint already forwarded
 * the original to the admin Gmail. Sender gets a generic ack — no
 * media-kit URL committed yet (deferred until a /press page exists).
 *
 * If/when we add a media kit, expand the reply template in
 * email-reply-builder.ts to include the URL conditionally.
 *
 * OPE-1066: the ack is a promise, so it now leaves a trace. A press inquiry
 * acknowledged and never answered was previously invisible to
 * `list_support_obligations` — the queue built to answer "who is owed a reply".
 */

import { getDb } from "../db.js";
import { openObligationIfOwed } from "./open-obligation.js";
import type { HandlerFn, HandlerResult } from "./types.js";

const SOURCE = "mcp:email-handler:press";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const obligationRef = await openObligationIfOwed(env, getDb(env.DB), row, SOURCE);

  return {
    replyKind: "press-ack",
    replyParams: { subject: row.subject ?? "" },
    status: "replied",
    crossingDestinationRef: obligationRef,
  };
};
