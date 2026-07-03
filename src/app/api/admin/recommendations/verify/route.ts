export const dynamic = "force-dynamic";
/**
 * OPE-77 (CPI Move 3) — recommendations verify-loop re-measure endpoint.
 *
 * Picks acted items whose verify snapshot is due (`verify_status='pending' AND
 * verify_due_at <= now`), re-reads each one's metric from stored data via its
 * rule's verifier, and disposes it:
 *   - improved     → verify_status='improved'; item stays acted (cleared).
 *   - no_movement  → verify_status='no_movement' AND actedAt=NULL, re-opening
 *                    the item into the active set as the "acted, no movement"
 *                    learning signal.
 * If the metric can't be read yet (no stored row) the item is left pending and
 * retried on the next run.
 *
 * Regressions: an item that improved but later regresses is re-created by the
 * normal scan (the rule re-matches when clicks drop back to 0), so no separate
 * regression pass is needed here.
 *
 * Auth: X-Internal-Key (called by the MCP daily recommendations-scan workflow).
 * Defensive by contract — wrapped so it never 500s; a bad item is logged and
 * skipped without aborting the run (per-item errors bubble up from
 * remeasureDueItems as a collected list).
 */

import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { remeasureDueItems } from "@/lib/recommendations/verify/remeasure";

export const POST = withInternalKey(
  { source: "/api/admin/recommendations/verify" },
  async ({ db }) => {
    try {
      const r = await remeasureDueItems(db, new Date());

      for (const e of r.errors) {
        await logError(db, {
          message: "recommendations verify: item re-measure failed",
          error: e.error,
          source: "recommendations.verify",
          context: { itemId: e.itemId, ruleKey: e.ruleKey },
        });
      }

      return NextResponse.json({
        ok: true,
        remeasured: r.remeasured,
        improved: r.improved,
        noMovement: r.noMovement,
        stillPending: r.stillPending,
      });
    } catch (err) {
      // Defensive: never 500. Log and report a non-ok body with a 200 so the
      // best-effort workflow step doesn't treat it as a hard failure.
      await logError(db, {
        message: "recommendations verify: re-measure run failed",
        error: err,
        source: "recommendations.verify",
      });
      return NextResponse.json(
        { ok: false, remeasured: 0, improved: 0, noMovement: 0, stillPending: 0 },
        { status: 200 }
      );
    }
  }
);
