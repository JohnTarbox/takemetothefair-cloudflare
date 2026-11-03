/**
 * OPE-328 — gemba@ handler. Records the observation in `gemba_observations`
 * (pending with an anchor, or held) for an agent session to post to Linear.
 * Sends nothing: the sender is John, and an auto-ack to your own observation
 * box is noise. Idempotent on the inbound row (UNIQUE inbound_email_id).
 */
import { getDb } from "../db.js";
import { gembaObservations } from "../schema.js";
import { routeGembaObservation } from "../inbound/gemba.js";
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const routed = routeGembaObservation(
    row.subject ?? null,
    row.bodyText ?? row.bodyTextExcerpt ?? null
  );
  await getDb(env.DB)
    .insert(gembaObservations)
    .values({
      inboundEmailId: row.id,
      project: routed.project,
      anchorIssue: routed.anchorIssue,
      status: routed.status,
      routingReason: routed.reason,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  return { replyKind: null, status: "forwarded" };
};
