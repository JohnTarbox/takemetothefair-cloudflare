export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { cpiSignalFilings } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

/**
 * POST /api/internal/cpi/record-filing  (OPE-76 — CPI Move 2)
 *
 * The write-back half of the auto-file rail. After a scheduled agent files an
 * OPE via Linear `save_issue`, it POSTs { fingerprint, opeId } here so the next
 * /fileable-signals scan sees the row as 'filed' (not re-proposed). Only a row
 * that exists AND is currently 'proposed' is transitioned — this is idempotent
 * and cannot resurrect a resolved row or clobber an already-filed one.
 *
 * Auth: X-Internal-Key. Defensive by contract: invalid input → 400 (not 500);
 * any unexpected throw is logged and returns { ok, updated: 0 }.
 */

const bodySchema = z.object({
  fingerprint: z.string().min(1).max(256),
  opeId: z.string().min(1).max(64),
});

export const POST = withInternalKey({ source: "cpi:record-filing" }, async ({ request, db }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json", updated: 0 }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_payload", updated: 0 }, { status: 400 });
  }

  const { fingerprint, opeId } = parsed.data;

  try {
    const existing = await db
      .select({ status: cpiSignalFilings.status })
      .from(cpiSignalFilings)
      .where(eq(cpiSignalFilings.fingerprint, fingerprint))
      .limit(1);

    // Only a live 'proposed' row is fileable — no-op otherwise (idempotent).
    if (!existing[0] || existing[0].status !== "proposed") {
      return NextResponse.json({ ok: true, updated: 0 });
    }

    await db
      .update(cpiSignalFilings)
      .set({ status: "filed", opeId, filedAt: new Date() })
      .where(eq(cpiSignalFilings.fingerprint, fingerprint));

    return NextResponse.json({ ok: true, updated: 1 });
  } catch (error) {
    await logError(db, {
      source: "cpi:record-filing",
      message: "record-filing write-back failed",
      error,
      context: { fingerprint, opeId },
    });
    return NextResponse.json({ ok: true, updated: 0 });
  }
});
