export const dynamic = "force-dynamic";
/**
 * Server-side R2 upload for event images. Mirrors
 * src/app/api/admin/vendors/[id]/upload-logo/route.ts almost exactly —
 * keeping them as separate files (rather than a generic /upload-asset/[kind])
 * because the auth, ownership, and post-write side-effects (recompute
 * completeness for the right entity) differ enough that the abstraction would
 * mostly be parameter passing.
 *
 * Two auth paths (via withAuthorized — admin session OR X-Internal-Key, the
 * latter checked constant-time):
 *   - Admin session (cookie) — same as the vendor route. Used by any future
 *     admin UI that exposes "upload event image".
 *   - X-Internal-Key header — used by the MCP server's `upload_event_image`
 *     tool so bulk image enrichment can run without an admin session.
 *
 * Posted as multipart form-data (field name: "file"). Returns the CDN URL
 * on success. Naming convention: `events/{eventId}/image-{ts}.{ext}` —
 * timestamp suffix defeats CDN caching when the image is replaced.
 */

import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — events tend to want larger banners than vendor logos.
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

const CDN_BASE = "https://cdn.meetmeatthefair.com";

function extensionFor(contentType: string): string | null {
  switch (contentType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

export const POST = withAuthorized<{ id: string }>(async ({ request, db, params, userId }) => {
  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };

  // Audit actor for the R2 customMetadata: the admin user id, or the
  // "mcp-server" sentinel when authorized via X-Internal-Key (userId is null
  // for the internal-key path, same as before's actorId mapping).
  const actorId = userId ?? "mcp-server";

  const { id } = params;

  // Confirm event exists before paying for the upload.
  const existing = await db.select({ id: events.id }).from(events).where(eq(events.id, id));
  if (existing.length === 0) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (e) {
    await logError(db, {
      message: "event-image-upload: invalid multipart body",
      error: e,
      source: "admin-event-image-upload",
    });
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 400 }
    );
  }

  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: `Unsupported content type "${contentType}". Allowed: jpg/png/webp/svg.` },
      { status: 400 }
    );
  }

  const ext = extensionFor(contentType);
  if (!ext) {
    return NextResponse.json({ error: "Unsupported content type" }, { status: 400 });
  }

  // The bucket binding is named VENDOR_ASSETS for historical reasons (it was
  // introduced for vendor logos in PR #20). The bucket itself is shared
  // (cdn.meetmeatthefair.com) and stores any kind of public asset; the name
  // is the binding identifier, not the bucket purpose. Renaming would
  // require coordinating with every Pages env + every consumer.
  const bucket = env.VENDOR_ASSETS;
  if (!bucket) {
    return NextResponse.json(
      { error: "R2 bucket not bound (VENDOR_ASSETS missing)" },
      { status: 500 }
    );
  }

  const key = `events/${id}/image-${Date.now()}.${ext}`;

  try {
    const body = await file.arrayBuffer();
    await bucket.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { uploadedBy: actorId, originalName: file.name },
    });
  } catch (e) {
    await logError(db, {
      message: "event-image-upload: R2 put failed",
      error: e,
      source: "admin-event-image-upload",
      context: { key },
    });
    return NextResponse.json({ error: "Upload failed" }, { status: 502 });
  }

  const url = `${CDN_BASE}/${key}`;

  try {
    await db.update(events).set({ imageUrl: url }).where(eq(events.id, id));
    await recomputeEventCompleteness(db, id);
  } catch (e) {
    await logError(db, {
      message: "event-image-upload: DB update failed (R2 has the file)",
      error: e,
      source: "admin-event-image-upload",
      context: { key, eventId: id },
    });
    return NextResponse.json(
      { error: "Uploaded but DB update failed; paste URL manually", url },
      { status: 502 }
    );
  }

  return NextResponse.json({ url, key });
});
