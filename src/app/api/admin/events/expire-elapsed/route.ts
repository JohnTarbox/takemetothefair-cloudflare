export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { expireElapsedEvents } from "@/lib/pending-buckets";

const bodySchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(300) });

/** OPE-1596 — bulk-reject PENDING events whose dates have passed. */
export const POST = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "ids must be a list of 1 to 300 event ids" },
      { status: 400 }
    );
  }
  try {
    const { expired } = await expireElapsedEvents(db, parsed.data.ids, session.user.id, new Date());
    return NextResponse.json({
      expired: expired.length,
      skipped: parsed.data.ids.length - expired.length,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to expire elapsed events",
      error,
      source: "api/admin/events/expire-elapsed",
      request,
    });
    return NextResponse.json({ error: "Failed to expire elapsed events" }, { status: 500 });
  }
});
