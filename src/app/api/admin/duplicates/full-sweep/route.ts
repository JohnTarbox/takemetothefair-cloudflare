export const dynamic = "force-dynamic";
/**
 * OPE-1597 — run the full-table similarity sweep for one entity type.
 *
 * Dual auth (admin session OR X-Internal-Key): the MCP Worker's daily cron POSTs
 * here once per type. Writes only the sweep's own two tables. Nothing merges.
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { isD1OverloadError, runFullDuplicateSweep } from "@/lib/duplicates/full-sweep";
import { FULL_SWEEP_TYPES } from "@/lib/duplicates/full-sweep-types";
import type { DuplicateEntityType } from "@/lib/duplicates/types";

export const POST = withAuthorized(async ({ request, db }) => {
  let type: unknown;
  try {
    ({ type } = (await request.json()) as { type?: unknown });
  } catch {
    type = undefined;
  }
  if (!FULL_SWEEP_TYPES.includes(type as DuplicateEntityType)) {
    return NextResponse.json(
      { error: `type must be one of ${FULL_SWEEP_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await runFullDuplicateSweep(db, type as DuplicateEntityType, {
      now: new Date(),
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    // OPE-1690 — a D1 overload is load, not a bug: 503 + retryable tells the
    // cron to back off and re-run this type rather than give up for the day.
    const overloaded = isD1OverloadError(error);
    await logError(db, {
      message: "Full duplicate sweep failed",
      error,
      source: "api/admin/duplicates/full-sweep",
      request,
      context: { type, overloaded },
      statusCode: overloaded ? 503 : 500,
    });
    return NextResponse.json(
      { error: "Full duplicate sweep failed", ...(overloaded ? { retryable: true } : {}) },
      { status: overloaded ? 503 : 500 }
    );
  }
});
