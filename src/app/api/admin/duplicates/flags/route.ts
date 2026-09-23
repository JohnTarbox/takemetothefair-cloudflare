export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import {
  dismissDuplicateFlag,
  listUnresolvedDuplicateFlags,
  rejectFlaggedAsDuplicate,
} from "@/lib/duplicates/flag-queue";

/**
 * OPE-1117 — the unresolved possible-duplicate queue.
 *
 * GET lists every flag no human has adjudicated. POST records a verdict on ONE
 * pair: `dismiss` ("two different events", written to its own table and to
 * neither `events` column) or `reject` ("a duplicate", REJECTED with the OPE-450
 * adjudication). Merge is deliberately not a verb here — it is the existing
 * `/api/admin/duplicates/merge`, so its cross-year guard and OPE-793 repoint
 * logic are the same code on every surface.
 *
 * `candidateId` is required on POST and must match the row's current flag, so a
 * verdict always names the pair the operator actually looked at.
 */
export const GET = withAuth(
  { role: "ADMIN", source: "api/admin/duplicates/flags" },
  async ({ request, db }) => {
    try {
      const flags = await listUnresolvedDuplicateFlags(db, new Date());
      return NextResponse.json({ flags, count: flags.length });
    } catch (error) {
      await logError(db, {
        message: "Failed to list duplicate flags",
        error,
        source: "api/admin/duplicates/flags",
        request,
      });
      return NextResponse.json({ error: "Failed to list duplicate flags" }, { status: 500 });
    }
  }
);

const bodySchema = z.object({
  eventId: z.string().min(1),
  candidateId: z.string().min(1),
  action: z.enum(["dismiss", "reject"]),
  note: z.string().max(1000).optional(),
});

export const POST = withAuth(
  { role: "ADMIN", source: "api/admin/duplicates/flags" },
  async ({ request, db, session }) => {
    let parsed: z.infer<typeof bodySchema>;
    try {
      parsed = bodySchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    try {
      const input = {
        eventId: parsed.eventId,
        candidateId: parsed.candidateId,
        actorUserId: session.user.id,
      };
      const result =
        parsed.action === "dismiss"
          ? await dismissDuplicateFlag(db, { ...input, note: parsed.note?.trim() || null })
          : await rejectFlaggedAsDuplicate(db, input);

      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 409;
        return NextResponse.json({ error: result.reason }, { status });
      }
      return NextResponse.json({ ok: true });
    } catch (error) {
      await logError(db, {
        message: "Failed to resolve duplicate flag",
        error,
        source: "api/admin/duplicates/flags",
        request,
      });
      return NextResponse.json({ error: "Failed to resolve duplicate flag" }, { status: 500 });
    }
  }
);
