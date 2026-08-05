export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withInternalKey } from "@/lib/api/with-auth";
import { membraneCrossings } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

/**
 * POST /api/internal/crossings/record  (OPE-326, on OPE-330's D-4 ledger)
 *
 * Records a membrane crossing that happens OUTSIDE any code path — specifically
 * the Open Engine queue-runner moving an issue from Agent Review back to Agent
 * Working on rework feedback.
 *
 * Why this route exists: `recordCrossing` (mcp-server) is called from inside
 * pipelines that already hold a Db handle. The runner is a human-and-agent loop
 * with no such handle, so `review_to_rework` was a declared crossing type that
 * nothing could ever write. OPE-326's acceptance requires the transition be
 * ledgered, and without this it silently would not be.
 *
 * Contrast with `recordCrossing`'s never-throw contract: there, a ledger failure
 * must not break the pipeline it observes. HERE the caller's entire purpose is
 * to ledger, so a failure is reported honestly rather than swallowed — a runner
 * told "recorded" when nothing was written is worse than one told it failed.
 *
 * Auth: X-Internal-Key.
 */

const bodySchema = z.object({
  sourceRef: z.string().min(1).max(256),
  /** Omitted for a terminal hold — that NULL is what the D-4 probe looks for. */
  destinationRef: z.string().min(1).max(256).optional(),
  crossingType: z.enum([
    "email_to_ticket",
    "email_to_hold",
    "hold_to_resolve",
    "review_to_rework",
    "route_to_lane",
  ]),
  actor: z.enum(["system", "agent", "human"]).optional(),
  notes: z.string().max(2000).optional(),
});

export const POST = withInternalKey({ source: "crossings:record" }, async ({ request, db }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  const { sourceRef, destinationRef, crossingType, actor, notes } = parsed.data;
  const id = crypto.randomUUID();

  try {
    await db.insert(membraneCrossings).values({
      id,
      sourceRef,
      destinationRef: destinationRef ?? null,
      crossingType,
      actor: actor ?? "agent",
      notes: notes ?? null,
      createdAt: new Date(),
    });
  } catch (error) {
    await logError(db, {
      level: "error",
      source: "crossings:record",
      message: `failed to record ${crossingType} crossing for ${sourceRef}`,
      error,
    });
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id });
});
