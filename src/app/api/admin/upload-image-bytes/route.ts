export const dynamic = "force-dynamic";
/**
 * Generic image upload endpoint accepting base64 bytes (NOT a URL).
 * Mirrors src/app/api/admin/events/[id]/upload-image/route.ts but works
 * for any target type: event / vendor / venue. Caller picks the target
 * via the `target_type` + `target_id` form fields.
 *
 * Why a separate endpoint vs reusing the per-entity upload routes:
 *   - The per-entity routes accept multipart FormData with field "file" —
 *     that's a fine UX from a browser form, but the MCP tool already has
 *     base64 bytes in hand (analyst spec, 2026-05-16). Adapting bytes
 *     into FormData on every MCP call works but adds boundary-encoding
 *     overhead and an extra fetch hop.
 *   - The MCP server fetches base64 bytes from the caller's payload
 *     and forwards them here as multipart. The bytes round-trip through
 *     a Blob without an external URL fetch (existing upload_event_image
 *     requires the source image to already be on a public URL — that's
 *     the gap the new tool closes).
 *
 * Phase 1 / 2a / 2b scope: see src/lib/upload-image-pipeline.ts for the
 * shared post-validation pipeline. This handler is now a thin shim that
 * authorizes, validates the multipart shape + caps, confirms the target
 * row exists, then delegates to runUploadPipeline.
 *
 * Auth: admin session OR X-Internal-Key.
 *
 * K17 (2026-06-07): pipeline body extracted to src/lib/upload-image-pipeline.ts
 * so the new /api/admin/upload-image-direct/[token] endpoint can reuse it.
 * Behavior parity with the pre-refactor version is the explicit goal.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, vendors, venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logError } from "@/lib/logger";
import {
  runUploadPipeline,
  PIPELINE_ALLOWED_TYPES,
  PIPELINE_MAX_BYTES,
  type PipelineTargetType,
} from "@/lib/upload-image-pipeline";

async function authorize(
  request: NextRequest,
  env: { INTERNAL_API_KEY?: string }
): Promise<{ ok: true; actorId: string } | { ok: false; status: number }> {
  const internalKey = request.headers.get("X-Internal-Key");
  if (internalKey && env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
    return { ok: true, actorId: "mcp-server" };
  }
  const session = await auth();
  if (session?.user?.role === "ADMIN") {
    return { ok: true, actorId: session.user.id };
  }
  return { ok: false, status: 401 };
}

export async function POST(request: NextRequest) {
  const env = getCloudflareEnv() as unknown as {
    INTERNAL_API_KEY?: string;
    VENDOR_ASSETS?: R2Bucket;
  };

  const authResult = await authorize(request, env);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: authResult.status });
  }
  const { actorId } = authResult;

  const db = getCloudflareDb();

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (e) {
    await logError(db, {
      message: "upload-image-bytes: invalid multipart body",
      error: e,
      source: "admin-upload-image-bytes",
    });
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  const targetType = formData.get("target_type") as PipelineTargetType | null;
  const targetId = formData.get("target_id") as string | null;
  const caption = (formData.get("caption") as string | null) || null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }
  if (!targetType || !["event", "vendor", "venue"].includes(targetType)) {
    return NextResponse.json(
      { error: "Missing or invalid 'target_type' (must be event / vendor / venue)" },
      { status: 400 }
    );
  }
  if (!targetId) {
    return NextResponse.json({ error: "Missing 'target_id'" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > PIPELINE_MAX_BYTES) {
    return NextResponse.json(
      {
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(2)} MB exceeds the ${
          PIPELINE_MAX_BYTES / 1024 / 1024
        } MB cap.`,
      },
      { status: 413 }
    );
  }

  const declaredType = file.type || "application/octet-stream";
  if (!PIPELINE_ALLOWED_TYPES.has(declaredType)) {
    return NextResponse.json(
      { error: `Unsupported content_type "${declaredType}". Allowed: jpg/png/webp/svg.` },
      { status: 400 }
    );
  }

  // Verify target row exists before doing the R2 put.
  let targetExists = false;
  if (targetType === "event") {
    const rows = await db.select({ id: events.id }).from(events).where(eq(events.id, targetId));
    targetExists = rows.length > 0;
  } else if (targetType === "vendor") {
    const rows = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, targetId));
    targetExists = rows.length > 0;
  } else {
    const rows = await db.select({ id: venues.id }).from(venues).where(eq(venues.id, targetId));
    targetExists = rows.length > 0;
  }
  if (!targetExists) {
    return NextResponse.json({ error: `${targetType} not found: ${targetId}` }, { status: 404 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await runUploadPipeline({
    bytes,
    declaredType,
    fileName: file.name,
    targetType,
    targetId,
    caption,
    actorId,
    uploadSource: "upload_image_bytes",
    db,
    env,
  });

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body);
}
