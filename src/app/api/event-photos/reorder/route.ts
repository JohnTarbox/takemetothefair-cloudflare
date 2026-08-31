export const dynamic = "force-dynamic";
/**
 * OPE-212 §5 — reorder an event's gallery. ADMIN ONLY.
 *
 * The vendor equivalent needs a cross-tenant guard because a vendor owns their
 * row and could name another vendor's photo id. An admin already may edit
 * every event, so there is no tenant boundary to cross — but the ids are still
 * checked against the event, because a mistyped id would otherwise silently
 * renumber a DIFFERENT event's gallery. Same check, different reason: not
 * privilege, correctness.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { eventPhotos } from "@/lib/db/schema";
import { assertPhotosBelongTo } from "@/lib/vendor-photo-auth";

const reorderSchema = z.object({
  eventId: z.string().min(1),
  photoIds: z.array(z.string().min(1)).min(1).max(100),
});

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 }
    );
  }
  const { eventId, photoIds } = parsed.data;

  const owned = await db
    .select({ id: eventPhotos.id })
    .from(eventPhotos)
    // OPE-686 — LIVE rows only. A tombstone in the owned set would let a
    // reorder silently resurrect a deleted photo into the middle of the order.
    .where(and(eq(eventPhotos.eventId, eventId), isNull(eventPhotos.deletedAt)));

  const belong = assertPhotosBelongTo(
    photoIds,
    owned.map((r) => r.id)
  );
  if (!belong.ok) {
    return NextResponse.json(
      { error: "One or more photos do not belong to this event", foreign: belong.foreign },
      { status: 400 }
    );
  }

  const now = new Date();
  for (let i = 0; i < photoIds.length; i++) {
    await db
      .update(eventPhotos)
      .set({ sortOrder: i, updatedAt: now })
      .where(eq(eventPhotos.id, photoIds[i]));
  }
  return NextResponse.json({ success: true, reordered: photoIds.length });
});
