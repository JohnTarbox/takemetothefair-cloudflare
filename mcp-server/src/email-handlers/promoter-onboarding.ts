/**
 * OPE-1608 — an organizer asking how to get their events listed. No generic ack:
 * the reply is a draft John approves, composed once the enrichment pass is done.
 * The sequence itself lives in ../inbound/promoter-onboarding.ts.
 */
import type { HandlerFn, HandlerResult } from "./types.js";
import { getDb } from "../db.js";
import { openOnboardingRequest } from "../inbound/promoter-onboarding.js";

export const handle: HandlerFn = async (env, _ctx, row): Promise<HandlerResult> => {
  const { obligationRef } = await openOnboardingRequest(getDb(env.DB), row);
  return {
    replyKind: null,
    status: "awaiting_human",
    crossingDestinationRef: obligationRef,
    skipAdminDecision: true,
  };
};
