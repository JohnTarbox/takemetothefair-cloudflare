export const dynamic = "force-dynamic";
/**
 * OPE-686 — the gallery maintenance operations, reachable from the MCP Worker.
 *
 * The public photo routes authenticate with a SESSION (`auth()`), which an MCP
 * tool cannot hold. Rather than give the MCP server a second implementation of
 * delete/rotate/reorder — the "one fix, two artifacts" defect this codebase
 * keeps rediscovering — it gets an `X-Internal-Key` door onto the SAME
 * functions the session routes call.
 *
 * One writer, two callers. A behaviour that only holds on the admin UI's path
 * is the reason `event_photos` and `vendor_photos` had drifted apart before
 * this ticket.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { withInternalKey } from "@/lib/api/with-auth";
import { eventPhotos, vendorPhotos } from "@/lib/db/schema";
import {
  readGallery,
  softDeleteGalleryPhoto,
  rotateGalleryPhoto,
  type GalleryTarget,
} from "@/lib/gallery-photo-mutations";
import { decodeHtmlEntities } from "@/lib/utils";

const bodySchema = z.object({
  target_type: z.enum(["event", "vendor"]),
  photo_id: z.string().min(1),
  action: z.enum(["delete", "rotate", "update", "read"]),
  degrees: z.number().int().optional(),
  caption: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  alt_text: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  is_featured: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  actor: z.string().optional(),
});

/** Resolve the owning entity from the photo id, and whether it is a tombstone. */
async function locate(
  db: Parameters<typeof readGallery>[0],
  target: GalleryTarget,
  photoId: string
): Promise<{ ownerId: string; deleted: boolean } | null> {
  if (target === "event") {
    const [row] = await db
      .select({ ownerId: eventPhotos.eventId, deletedAt: eventPhotos.deletedAt })
      .from(eventPhotos)
      .where(eq(eventPhotos.id, photoId))
      .limit(1);
    return row ? { ownerId: row.ownerId, deleted: !!row.deletedAt } : null;
  }
  const [row] = await db
    .select({ ownerId: vendorPhotos.vendorId, deletedAt: vendorPhotos.deletedAt })
    .from(vendorPhotos)
    .where(eq(vendorPhotos.id, photoId))
    .limit(1);
  return row ? { ownerId: row.ownerId, deleted: !!row.deletedAt } : null;
}

export const POST = withInternalKey(async ({ request, db }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 }
    );
  }
  const p = parsed.data;
  const target = p.target_type as GalleryTarget;

  const found = await locate(db, target, p.photo_id);
  if (!found) return NextResponse.json({ error: "Photo not found" }, { status: 404 });

  if (p.action === "read") {
    return NextResponse.json({ gallery: await readGallery(db, target, found.ownerId) });
  }

  if (p.action === "delete") {
    // Idempotent by design: a tombstone returns the current gallery rather than
    // an error, so an agent retrying a timed-out call converges.
    const result = await softDeleteGalleryPhoto(db, {
      target,
      ownerId: found.ownerId,
      photoId: p.photo_id,
      actorUserId: p.actor ?? null,
      via: "mcp",
    });
    return NextResponse.json({ success: true, ...result });
  }

  // Everything below EDITS a live photo, so a tombstone is refused: silently
  // editing something invisible is worse than an error.
  if (found.deleted) {
    return NextResponse.json({ error: "Photo has been deleted" }, { status: 410 });
  }

  if (p.action === "rotate") {
    if (p.degrees == null) {
      return NextResponse.json({ error: "rotate requires `degrees`" }, { status: 400 });
    }
    try {
      const res = await rotateGalleryPhoto(db, {
        target,
        ownerId: found.ownerId,
        photoId: p.photo_id,
        degrees: p.degrees,
        actorUserId: p.actor ?? null,
        via: "mcp",
      });
      return NextResponse.json({
        success: true,
        ...res,
        gallery: await readGallery(db, target, found.ownerId),
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  // action === "update"
  const now = new Date();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (p.caption !== undefined) updates.caption = p.caption ?? null;
  if (p.alt_text !== undefined) updates.altText = p.alt_text ?? null;
  if (p.sort_order !== undefined) updates.sortOrder = p.sort_order;

  const table = target === "event" ? eventPhotos : vendorPhotos;
  const ownerCol = target === "event" ? eventPhotos.eventId : vendorPhotos.vendorId;
  const deletedCol = target === "event" ? eventPhotos.deletedAt : vendorPhotos.deletedAt;
  const idCol = target === "event" ? eventPhotos.id : vendorPhotos.id;

  // Featured is exclusive per owner, demoted server-side so two concurrent
  // promotions cannot both stick. Live rows only — demoting tombstones would
  // be a pointless write, and promoting one would be a bug.
  if (p.is_featured === true) {
    await db
      .update(table)
      .set({ isFeatured: false, updatedAt: now })
      .where(and(eq(ownerCol, found.ownerId), isNull(deletedCol)));
    updates.isFeatured = true;
  } else if (p.is_featured === false) {
    updates.isFeatured = false;
  }
  await db.update(table).set(updates).where(eq(idCol, p.photo_id));

  return NextResponse.json({
    success: true,
    photo_id: p.photo_id,
    gallery: await readGallery(db, target, found.ownerId),
  });
});
