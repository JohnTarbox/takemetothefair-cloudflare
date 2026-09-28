export const dynamic = "force-dynamic";
/**
 * OPE-1201 — run the near-duplicate candidate pass over existing live events.
 *
 * Dual auth (admin session OR X-Internal-Key): the MCP Worker's daily cron POSTs
 * here with `{ "dry_run": false }`; an operator can POST `{}` to see the plan.
 * **`dry_run` defaults to TRUE** — a caller has to ask for writes.
 *
 * Report-only either way: the only column it ever writes is
 * `events.possible_duplicate_of`, and only where it is NULL. Candidates land in
 * the OPE-1117 flag queue (/admin/duplicates/flags), where a human decides.
 * See src/lib/duplicates/near-duplicate-sweep.ts for the predicate and why.
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { runNearDuplicateSweep } from "@/lib/duplicates/near-duplicate-sweep";

export const POST = withAuthorized(async ({ request, db }) => {
  try {
    let dryRun = true;
    try {
      const body = (await request.json()) as { dry_run?: unknown };
      if (body.dry_run === false) dryRun = false;
    } catch {
      // No / invalid body → the safe default, a dry run.
    }

    const result = await runNearDuplicateSweep(db, { now: new Date(), dryRun });
    return NextResponse.json({
      success: true,
      dry_run: result.dryRun,
      counts: {
        examined: result.examined,
        planned: result.planned.length,
        written: result.written,
      },
      pairs: result.planned,
      next_action_hint:
        "Each pair is a CANDIDATE. Triage in /admin/duplicates/flags: merge_events for a true duplicate, dismiss otherwise (a dismissal is never re-flagged).",
    });
  } catch (error) {
    await logError(db, {
      message: "Near-duplicate sweep failed",
      error,
      source: "admin-duplicates-near-sweep",
      request,
      statusCode: 500,
    });
    return NextResponse.json(
      { success: false, error: "Failed to run near-duplicate sweep" },
      { status: 500 }
    );
  }
});
