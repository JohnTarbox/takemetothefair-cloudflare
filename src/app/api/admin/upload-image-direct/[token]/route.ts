export const dynamic = "force-dynamic";
/**
 * K17 (2026-06-07): consume an upload slot by POSTing image bytes here.
 *
 * Paired with /api/admin/upload-image-slot (which mints the token). The
 * token is its own authorization — no admin session or X-Internal-Key
 * needed; the caller proves they hold a valid one-shot URL by including
 * its token in the path.
 *
 * Why path token vs header / query:
 *   - Path: one URL, one POST, easy for Claude Desktop's HTTP client.
 *     Token may end up in some access logs but the 5-min TTL + one-shot
 *     consume bound the blast radius (already-consumed tokens are inert).
 *   - Query: same logging concern, less natural for "POST this URL with
 *     these bytes."
 *   - Header: cleaner secret hygiene, but requires the client to set a
 *     header — many file-upload UIs only let you specify a URL.
 *
 * Accepts two body shapes:
 *   - multipart/form-data with a `file` field (matches upload_image_bytes)
 *   - raw bytes (Content-Type set to the image MIME type)
 *
 * The slot's claims fix the target — the body of THIS request does NOT
 * specify target_type / target_id. That's the point: the slot's issuer
 * already validated the target exists; the consumer can only upload to
 * the target the slot was minted for.
 */

import { NextRequest, NextResponse } from "next/server";

import { getCloudflareDb, getCloudflareEnv, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import {
  runUploadPipeline,
  PIPELINE_ALLOWED_TYPES,
  PIPELINE_MAX_BYTES,
} from "@/lib/upload-image-pipeline";
import { consumeUploadSlot } from "@/lib/upload-slot-token";

async function readBytesFromRequest(
  request: NextRequest
): Promise<
  | { ok: true; bytes: Uint8Array; declaredType: string; fileName: string; caption: string | null }
  | { ok: false; status: number; error: string }
> {
  const contentType = request.headers.get("Content-Type") || "";

  if (contentType.startsWith("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return { ok: false, status: 400, error: "Invalid multipart body" };
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return { ok: false, status: 400, error: "Missing 'file' field in multipart body" };
    }
    if (file.size === 0) return { ok: false, status: 400, error: "Empty file" };
    if (file.size > PIPELINE_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(2)} MB exceeds the ${
          PIPELINE_MAX_BYTES / 1024 / 1024
        } MB cap.`,
      };
    }
    const declaredType = file.type || "application/octet-stream";
    if (!PIPELINE_ALLOWED_TYPES.has(declaredType)) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported content_type "${declaredType}". Allowed: jpg/png/webp/svg.`,
      };
    }
    const formCaption = formData.get("caption");
    const caption = typeof formCaption === "string" ? formCaption.slice(0, 200) : null;
    return {
      ok: true,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredType,
      fileName: file.name || "upload",
      caption,
    };
  }

  // Raw-body path: Content-Type is the image MIME type itself.
  if (!PIPELINE_ALLOWED_TYPES.has(contentType)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported Content-Type "${contentType}". Allowed: jpg/png/webp/svg or multipart/form-data.`,
    };
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return { ok: false, status: 400, error: "Empty body" };
  if (buf.byteLength > PIPELINE_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Body too large: ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB exceeds the ${
        PIPELINE_MAX_BYTES / 1024 / 1024
      } MB cap.`,
    };
  }
  return {
    ok: true,
    bytes: new Uint8Array(buf),
    declaredType: contentType,
    fileName: "upload",
    caption: null,
  };
}

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const env = getCloudflareEnv() as unknown as { VENDOR_ASSETS?: R2Bucket };

  const kv = getCloudflareRateLimitKv();
  if (!kv) {
    // KV missing is an infra problem, not a client problem — but we
    // can't distinguish "bad token" from "no KV" without revealing one,
    // so return the same generic 401 the bad-token path uses.
    return NextResponse.json({ error: "Invalid or expired upload slot" }, { status: 401 });
  }

  const claims = await consumeUploadSlot(kv, token);
  if (!claims) {
    return NextResponse.json({ error: "Invalid or expired upload slot" }, { status: 401 });
  }

  const db = getCloudflareDb();

  const bytesResult = await readBytesFromRequest(request);
  if (!bytesResult.ok) {
    await logError(db, {
      level: "warn",
      message: `upload-image-direct: ${bytesResult.error}`,
      source: "admin-upload-image-direct",
      context: { targetType: claims.targetType, targetId: claims.targetId },
    });
    return NextResponse.json({ error: bytesResult.error }, { status: bytesResult.status });
  }

  const { bytes, declaredType, fileName, caption } = bytesResult;
  const effectiveCaption = caption ?? claims.caption;

  // Belt-and-braces: even though the slot was minted against a known
  // cap, re-check here so a slot from a future version with a higher
  // cap doesn't bypass this endpoint's runtime limits.
  if (bytes.length > claims.maxBytes) {
    return NextResponse.json(
      {
        error: `Body exceeds slot's max_bytes (${claims.maxBytes} bytes); request a new slot.`,
      },
      { status: 413 }
    );
  }

  const result = await runUploadPipeline({
    bytes,
    declaredType,
    fileName,
    targetType: claims.targetType,
    targetId: claims.targetId,
    caption: effectiveCaption,
    actorId: claims.issuedBy,
    uploadSource: "upload_image_slot",
    db,
    env,
  });

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body);
}
