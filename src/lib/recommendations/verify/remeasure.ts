/**
 * OPE-77 (CPI Move 3) — re-measure core for the recommendations verify loop.
 *
 * Extracted from the HTTP route so it can be unit-tested directly against a
 * seeded DB. Selects acted items whose verify snapshot is due, re-reads each
 * one's metric via its rule's verifier, and disposes it (improved → stays
 * cleared; no_movement → re-opened via actedAt=NULL). Collects per-item errors
 * instead of logging so it stays I/O-light and testable; the caller logs them.
 */

import { and, eq, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { recommendationItems, recommendationRules } from "@/lib/db/schema";
import { getVerifier } from "./registry";
import { decideVerifyOutcome } from "./decide";

type Db = DrizzleD1Database<typeof schema>;

/** Cap per run so one invocation can't sweep an unbounded backlog. */
export const VERIFY_MAX_PER_RUN = 200;

export interface RemeasureResult {
  remeasured: number;
  improved: number;
  noMovement: number;
  stillPending: number;
  /** Per-item failures; the caller decides how to log them. */
  errors: Array<{ itemId: string; ruleKey: string; error: unknown }>;
}

export async function remeasureDueItems(
  db: Db,
  now: Date,
  max: number = VERIFY_MAX_PER_RUN
): Promise<RemeasureResult> {
  const result: RemeasureResult = {
    remeasured: 0,
    improved: 0,
    noMovement: 0,
    stillPending: 0,
    errors: [],
  };

  const rows = await db
    .select({
      id: recommendationItems.id,
      targetId: recommendationItems.targetId,
      payloadJson: recommendationItems.payloadJson,
      verifySnapshot: recommendationItems.verifySnapshot,
      ruleKey: recommendationRules.ruleKey,
    })
    .from(recommendationItems)
    .innerJoin(recommendationRules, eq(recommendationItems.ruleId, recommendationRules.id))
    .where(
      and(
        eq(recommendationItems.verifyStatus, "pending"),
        lte(recommendationItems.verifyDueAt, now)
      )
    )
    .limit(max);

  for (const row of rows) {
    try {
      const verifier = getVerifier(row.ruleKey);
      // Rule left the registry since the snapshot — leave the item untouched.
      if (!verifier) continue;

      const after = await verifier.readMetric(db, {
        targetId: row.targetId,
        payloadJson: row.payloadJson,
      });
      if (!after) {
        // No stored metric yet — retry next run.
        result.stillPending++;
        continue;
      }

      let before: Record<string, number> = {};
      if (row.verifySnapshot) {
        try {
          before = JSON.parse(row.verifySnapshot) as Record<string, number>;
        } catch {
          before = {};
        }
      }

      const decision = decideVerifyOutcome(row.ruleKey, before, after);
      result.remeasured++;

      if (decision.outcome === "improved") {
        result.improved++;
        await db
          .update(recommendationItems)
          .set({
            verifyStatus: "improved",
            verifyAfter: JSON.stringify(after),
            verifyRemeasuredAt: now,
            verifyReason: decision.reason,
          })
          .where(eq(recommendationItems.id, row.id));
      } else {
        result.noMovement++;
        await db
          .update(recommendationItems)
          .set({
            verifyStatus: "no_movement",
            verifyAfter: JSON.stringify(after),
            verifyRemeasuredAt: now,
            verifyReason: decision.reason,
            // Re-open: actedAt=NULL re-enters the active set. verify_snapshot
            // is kept for reference.
            actedAt: null,
          })
          .where(eq(recommendationItems.id, row.id));
      }
    } catch (error) {
      // One bad item must not abort the whole run.
      result.errors.push({ itemId: row.id, ruleKey: row.ruleKey, error });
    }
  }

  return result;
}
