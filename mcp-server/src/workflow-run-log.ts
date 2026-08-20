/**
 * OPE-501 — record what a Workflow run actually did, step by step.
 *
 * Fail-soft by contract: this is evidence, and evidence must never cost the work
 * it describes. Every helper swallows its own errors.
 */
import { workflowRunSteps } from "./schema.js";
import type { Db } from "./db.js";

export type StepStatus = "ok" | "failed" | "skipped";

export interface StepRecord {
  instanceId: string;
  workflowName: string;
  inboundEmailId?: string | null;
  stepName: string;
  status: StepStatus;
  detail?: unknown;
  durationMs?: number;
}

/**
 * Write one step outcome.
 *
 * `skipped` is the whole point. A step that never ran is indistinguishable from
 * a step that ran and found nothing — which is exactly the ambiguity that made
 * the 2026-08-20 `c00f0865` finding unfileable — so a skip must be recorded as
 * deliberately as a success, WITH its reason.
 */
export async function recordWorkflowStep(db: Db, rec: StepRecord): Promise<void> {
  try {
    await db.insert(workflowRunSteps).values({
      instanceId: rec.instanceId,
      workflowName: rec.workflowName,
      inboundEmailId: rec.inboundEmailId ?? null,
      stepName: rec.stepName,
      status: rec.status,
      detail: rec.detail === undefined ? null : JSON.stringify(rec.detail),
      durationMs: rec.durationMs ?? null,
      recordedAt: new Date(),
    });
  } catch {
    // Never throw from the evidence path.
  }
}
