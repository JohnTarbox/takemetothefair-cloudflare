export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { faultSignatures } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

/**
 * POST /api/internal/faults/record-candidate  (OPE-81 — render-fault rail)
 *
 * The write-back half of the fault rail. After a scheduled agent files (or
 * resolves) a fault OPE via Linear `save_issue`, it POSTs { signature, opeId,
 * status } here so the next /candidates scan sees the row correctly:
 *   - status 'filed' → only transitions a row currently 'proposed' | 'regressed'
 *     (records opeId + filedAt). Cannot resurrect a done row or re-file a filed one.
 *   - status 'done'  → only transitions a row currently 'filed' | 'regressed'
 *     (sets resolvedAt=now). A later recurrence past resolvedAt reopens it as a
 *     regression in the reconcile core.
 * Any other current status is a no-op. Idempotent by construction.
 *
 * Auth: X-Internal-Key. Defensive by contract: invalid input → 400 (not 500);
 * any unexpected throw is logged and returns { ok, updated: 0 }.
 */

const bodySchema = z.object({
  signature: z.string().min(1).max(256),
  opeId: z.string().min(1).max(64),
  status: z.enum(["filed", "done"]).default("filed"),
});

export const POST = withInternalKey(
  { source: "faults:record-candidate" },
  async ({ request, db }) => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_json", updated: 0 }, { status: 400 });
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "invalid_payload", updated: 0 },
        { status: 400 }
      );
    }

    const { signature, opeId, status } = parsed.data;

    try {
      const existing = await db
        .select({ status: faultSignatures.status })
        .from(faultSignatures)
        .where(eq(faultSignatures.signature, signature))
        .limit(1);

      const current = existing[0]?.status;
      if (!current) {
        return NextResponse.json({ ok: true, updated: 0 });
      }

      if (status === "filed") {
        // Only a proposed/regressed row is fileable — no-op otherwise.
        if (current !== "proposed" && current !== "regressed") {
          return NextResponse.json({ ok: true, updated: 0 });
        }
        await db
          .update(faultSignatures)
          .set({ status: "filed", opeId, filedAt: new Date() })
          .where(eq(faultSignatures.signature, signature));
        return NextResponse.json({ ok: true, updated: 1 });
      }

      // status === "done": only a filed/regressed row can be resolved.
      if (current !== "filed" && current !== "regressed") {
        return NextResponse.json({ ok: true, updated: 0 });
      }
      await db
        .update(faultSignatures)
        .set({ status: "done", opeId, resolvedAt: new Date() })
        .where(eq(faultSignatures.signature, signature));
      return NextResponse.json({ ok: true, updated: 1 });
    } catch (error) {
      await logError(db, {
        source: "faults:record-candidate",
        message: "record-candidate write-back failed",
        error,
        context: { signature, opeId, status },
      });
      return NextResponse.json({ ok: true, updated: 0 });
    }
  }
);
